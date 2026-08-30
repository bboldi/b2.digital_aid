import { authenticator } from 'otplib';
import QRCode from 'qrcode';

authenticator.options = { window: 1 };

export function generateSecret() {
  return authenticator.generateSecret(20);
}

export function verifyCode(code, secret) {
  return authenticator.check(code, secret);
}

/// The code an authenticator app would show right now, plus how long it stays valid.
/// Shown to the logged-in Admin so a phone is not required to hand out extra time.
export function currentCode(secret) {
  return {
    code: authenticator.generate(secret),
    secondsLeft: 30 - (Math.floor(Date.now() / 1000) % 30),
  };
}

export async function secretQrDataUrl(secret, label = 'Digital Aid') {
  const uri = authenticator.keyuri('family', label, secret);
  return QRCode.toDataURL(uri, { margin: 1, width: 240 });
}
