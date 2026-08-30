using Microsoft.Win32;

namespace DigitalAid.Client.App;

/// <summary>
/// A stable identifier for this PC, sent at pairing so a server that already knows the machine can
/// offer its Client back instead of starting a second one (ADR-0008).
///
/// Windows' <c>MachineGuid</c>: written once when the OS is installed, unaffected by reinstalling
/// this app or losing its state file — which is exactly the accident this exists for — and different
/// after a reimage, which is correct, because that is a different installation.
///
/// It is not secret and it is not a credential. Pairing still costs an [[Admin Code]]; this only
/// proposes *which* Client that code applies to. Nor is it unique: cloned VMs and reimaged PCs can
/// repeat one, which is why the server asks rather than adopting silently.
/// </summary>
public static class MachineId
{
    private const string Key = @"SOFTWARE\Microsoft\Cryptography";

    /// <summary>Null if it cannot be read. Not worth reporting: a Client that sends no machine id
    /// pairs exactly as every Client did before this existed.</summary>
    public static string? Read()
    {
        try
        {
            // Explicitly the 64-bit view. This process is 64-bit today, but under WOW64 the redirect
            // would hand back a *different* GUID, and an id that changes with the build is worse
            // than none at all.
            using var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var crypto = hklm.OpenSubKey(Key);
            var value = crypto?.GetValue("MachineGuid") as string;
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }
        catch (Exception)
        {
            return null;
        }
    }
}
