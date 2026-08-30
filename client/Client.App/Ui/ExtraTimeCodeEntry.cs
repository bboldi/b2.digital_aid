using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App.Ui;

/// <summary>
/// The box an Extra Time Code is typed into away from the Block Screen — inside "ask for more time",
/// and in its own window from the tray. Both exist because until now a code could only be redeemed
/// once the machine was *already* blocked, so a parent could not give time ahead of running out.
///
/// It redeems Grants only. A bare [[Admin Code]] fails here exactly as it does on the cover, and for
/// the same reason: a kid told "482913, plus 30" would otherwise be able to type the first half and
/// exit the app instead. That falls out of the format itself — a code with no minutes on the end does
/// not parse as a Grant — so there is nothing extra to enforce.
///
/// Like the cover, it never explains the format. A kid who learns the minutes are simply typed on the
/// end learns they can type 999 of them; codes are read out whole, so no instruction is needed.
/// </summary>
public sealed class ExtraTimeCodeEntry : StackPanel
{
    private readonly TextBox _input;
    private readonly TextBlock _feedback;
    private readonly Func<string, RedeemResult> _redeem;
    private readonly Func<string, Task<string?>>? _redeemCoupon;
    private bool _regrouping;

    /// <summary>Raised once a code has actually granted time.</summary>
    public event Action? Redeemed;

    public ExtraTimeCodeEntry(Func<string, RedeemResult> redeem, Func<string, Task<string?>>? redeemCoupon = null,
        string? prompt = null)
    {
        _redeem = redeem;
        _redeemCoupon = redeemCoupon;

        Children.Add(new TextBlock
        {
            Text = prompt ?? Strings.BlockGotCode,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 6),
        });

        _input = new TextBox
        {
            // Eleven, not nine: a code is nine digits written in threes, and the two dashes are
            // characters in this box like any other (ADR-0014).
            MaxLength = 11,
            FontSize = 20,
            Padding = new Thickness(6),
            HorizontalContentAlignment = HorizontalAlignment.Center,
        };
        _input.KeyDown += (_, e) => { if (e.Key == Key.Enter) Try(); };
        _input.TextChanged += (_, _) => Regroup();
        Children.Add(_input);

        var use = new Button
        {
            Content = Strings.ExtraCodeUse,
            MinWidth = 130,
            Padding = new Thickness(8, 5, 8, 5),
            Margin = new Thickness(0, 8, 0, 0),
            HorizontalAlignment = HorizontalAlignment.Right,
            Cursor = Cursors.Hand,
        };
        use.Click += (_, _) => Try();
        Children.Add(use);

        _feedback = new TextBlock
        {
            FontSize = 12,
            MinHeight = 18,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 6, 0, 0),
        };
        Children.Add(_feedback);
    }

    public void FocusInput() => _input.Focus();

    /// <summary>Puts the dashes in as the code is typed, so the box shows `482-102-015` whether it
    /// was typed digit by digit or pasted whole from a message. The grouping is only a way of
    /// showing the number — <see cref="GrantCode.TryParse"/> strips it straight back out — so
    /// nothing downstream can tell the difference.
    ///
    /// It deliberately does not strip anything that is *not* a separator. Swallowing a mistyped
    /// letter would hide the one thing worth seeing: the code would simply be refused later, with
    /// the box still looking correct.</summary>
    private void Regroup()
    {
        if (_regrouping) return;
        var raw = _input.Text;
        var bare = new string(raw.Where(c => c is not ('-' or ' ')).ToArray()).ToUpperInvariant();
        if (!bare.All(c => char.IsAsciiDigit(c) || char.IsAsciiLetter(c))) return;

        var grouped = Group(bare);
        if (grouped == raw) return;

        // Re-anchor on how many digits/letters stood to the left of the cursor, not on its index —
        // inserting a dash shifts every index after it, and a cursor that jumps mid-code costs more
        // than the grouping is worth.
        var digitsBefore = raw.Take(_input.CaretIndex).Count(char.IsAsciiLetterOrDigit);
        _regrouping = true;
        try
        {
            _input.Text = grouped;
            _input.CaretIndex = CaretAfter(grouped, digitsBefore);
        }
        finally { _regrouping = false; }
    }

    private static string Group(string digits) => digits.Length switch
    {
        <= 3 => digits,
        <= 6 => $"{digits[..3]}-{digits[3..]}",
        _ => $"{digits[..3]}-{digits[3..6]}-{digits[6..]}",
    };

    private static int CaretAfter(string text, int digits)
    {
        if (digits == 0) return 0;
        var seen = 0;
        for (var i = 0; i < text.Length; i++)
            if (char.IsAsciiLetterOrDigit(text[i]) && ++seen == digits) return i + 1;
        return text.Length;
    }

    private async void Try()
    {
        if (_redeemCoupon is not null && CouponCode.LooksLikeCoupon(_input.Text))
        {
            // A coupon is the server's to judge (ADR-0017): disable the button, say "checking",
            // and show whichever honest sentence comes back. Null means it was granted.
            _input.IsEnabled = false;
            _feedback.Foreground = new SolidColorBrush(Color.FromRgb(0x66, 0x66, 0x66));
            _feedback.Text = Strings.CouponChecking;
            var refusal = await _redeemCoupon(_input.Text);
            _input.IsEnabled = true;
            if (refusal is null)
            {
                _feedback.Text = string.Empty;
                _input.Clear();
                Redeemed?.Invoke();
                return;
            }
            _feedback.Foreground = new SolidColorBrush(Color.FromRgb(0xB0, 0x3A, 0x2B));
            _feedback.Text = refusal;
            return;
        }

        var result = _redeem(_input.Text);
        if (result == RedeemResult.Granted)
        {
            _input.Clear();
            Redeemed?.Invoke();
            return;
        }

        // As uninformative about *why* as the Block Screen is, for the same reason.
        _feedback.Foreground = new SolidColorBrush(Color.FromRgb(0xB0, 0x3A, 0x2B));
        _feedback.Text = result switch
        {
            RedeemResult.CodeAlreadyUsed => Strings.CodeAlreadyUsed,
            _ => Strings.CodeBad,
        };
    }
}
