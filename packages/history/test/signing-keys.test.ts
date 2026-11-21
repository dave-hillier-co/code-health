import { expect, test } from "vitest";
import { isPlatformKey, signingKeyOf, signaturesIn } from "../src/signing-keys.ts";

const pgp = [
  "-----BEGIN PGP SIGNATURE-----",
  "",
  "iJEEABYKADkWIQSVbtGNQydrzXJORR657dFhxhPx2wUCawGmOhsUgAAAAAAEAA5t",
  "YW51MiwyLjUrMS4xMiwwLDMACgkQue3RYcYT8dvw/QD9Fpcs0ZxucAbkDVo2Wmui",
  "E+89AqKksvnbedAFYxKFP+ABAPoIDxJSKawvVNvWzRGq29WLDEl9AQ/4Xhdi5E7n",
  "FfkC",
  "=0/5i",
  "-----END PGP SIGNATURE-----",
].join("\n");

const ssh = [
  "-----BEGIN SSH SIGNATURE-----",
  "U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgfDL1gfDvUzs2Tf56OWUdc9V7iN",
  "zRsRHe3d4AWAiCnB8AAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5",
  "AAAAQB5eSZZjPS9VJ4uKkLGaCRUIR8nRNo4tV+jhbUZfETVxBbNRDHI2iEbmnDRtXwuiLI",
  "zZyI1qNLySbShUEfk75AU=",
  "-----END SSH SIGNATURE-----",
].join("\n");

test("an OpenPGP signature names its key by the long id of the issuer's fingerprint", () => {
  expect(signingKeyOf(pgp)).toBe("gpg:B9EDD161C613F1DB");
});

test("an SSH signature names its key by the SHA256 fingerprint ssh-keygen shows", () => {
  expect(signingKeyOf(ssh)).toBe("ssh:SHA256:QuGeMST7unW0adAW1t9cHZOL34Vm+C2td8jm6V1Nebw");
});

test.each(["", "not a signature", "-----BEGIN PGP SIGNATURE-----\n\n!!!!\n-----END PGP SIGNATURE-----", "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----"])(
  "text that is no usable signature gives no key: %j",
  (text) => {
    expect(signingKeyOf(text)).toBeUndefined();
  },
);

test("GitHub's web-flow key is a platform key, and an ordinary key is not", () => {
  expect(isPlatformKey("gpg:B5690EEEBB952194")).toBe(true);
  expect(isPlatformKey("gpg:B9EDD161C613F1DB")).toBe(false);
});

test("signatures are read from the raw log by commit, past blank lines inside the armor and the message that follows", () => {
  const raw = [
    "commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "tree 1",
    "author A <a@x> 1 +0000",
    "committer A <a@x> 1 +0000",
    ...("gpgsig " + pgp).split("\n").map((line, index) => (index === 0 ? line : ` ${line}`)),
    "",
    "    signed message",
    "    with  text",
    "",
    "commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "tree 2",
    "author B <b@x> 2 +0000",
    "committer B <b@x> 2 +0000",
    "",
    "    unsigned",
    "",
  ].join("\n");
  expect([...signaturesIn(raw)]).toEqual([["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "gpg:B9EDD161C613F1DB"]]);
});
