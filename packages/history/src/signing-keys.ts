import { createHash } from "node:crypto";

/** The long key id of GitHub's web-flow key, which signs every user's web-UI commits and so says nothing about who made them. */
const PLATFORM_KEYS = new Set(["gpg:B5690EEEBB952194"]);

export const isPlatformKey = (key: string): boolean => PLATFORM_KEYS.has(key);

function armoredBody(text: string, kind: string): Buffer | undefined {
  const begin = text.indexOf(`-----BEGIN ${kind}-----`);
  const end = text.indexOf(`-----END ${kind}-----`);
  if (begin === -1 || end === -1 || end < begin) return undefined;
  const lines = text.slice(begin + `-----BEGIN ${kind}-----`.length, end).split("\n").map((line) => line.trim());
  // OpenPGP armor has optional headers up to a blank line, and a checksum line that starts with `=`.
  const blank = lines.indexOf("");
  const body = (blank > 0 ? lines.slice(blank + 1) : lines).filter((line) => line !== "" && !line.startsWith("="));
  const bytes = Buffer.from(body.join(""), "base64");
  return bytes.length === 0 ? undefined : bytes;
}

/** An SSH signature carries the signer's public key, whose SHA256 fingerprint is what `ssh-keygen -l` prints. */
function sshKey(text: string): string | undefined {
  const bytes = armoredBody(text, "SSH SIGNATURE");
  if (bytes === undefined || bytes.length < 14 || bytes.subarray(0, 6).toString("latin1") !== "SSHSIG") return undefined;
  const length = bytes.readUInt32BE(10);
  if (length === 0 || 14 + length > bytes.length) return undefined;
  const fingerprint = createHash("sha256").update(bytes.subarray(14, 14 + length)).digest("base64").replace(/=+$/, "");
  return `ssh:SHA256:${fingerprint}`;
}

/** The issuer's key id from the subpackets of a version 4 or 5 OpenPGP signature packet. */
function issuerOf(packet: Buffer): string | undefined {
  if (packet.length < 6 || (packet[0] !== 4 && packet[0] !== 5)) return undefined;
  let fingerprint: string | undefined;
  let keyId: string | undefined;
  let offset = 4;
  for (let area = 0; area < 2; area++) {
    if (offset + 2 > packet.length) break;
    const size = packet.readUInt16BE(offset);
    let at = offset + 2;
    const end = Math.min(packet.length, at + size);
    while (at < end) {
      let length = packet[at]!;
      at++;
      if (length >= 192 && length < 255) {
        length = ((length - 192) << 8) + (packet[at] ?? 0) + 192;
        at++;
      } else if (length === 255) {
        length = packet.readUInt32BE(at);
        at += 4;
      }
      const type = (packet[at] ?? 0) & 0x7f;
      const data = packet.subarray(at + 1, at + length);
      if (type === 33 && data.length > 1) fingerprint = data.subarray(1).toString("hex").toUpperCase();
      if (type === 16 && data.length === 8) keyId = data.toString("hex").toUpperCase();
      at += length;
    }
    offset = end;
  }
  return fingerprint !== undefined ? fingerprint.slice(-16) : keyId;
}

function pgpKey(text: string): string | undefined {
  const bytes = armoredBody(text, "PGP SIGNATURE");
  if (bytes === undefined) return undefined;
  const first = bytes[0]!;
  if ((first & 0x80) === 0) return undefined;
  let tag: number;
  let length: number;
  let at = 1;
  if (first & 0x40) {
    tag = first & 0x3f;
    const octet = bytes[at++] ?? 0;
    if (octet < 192) length = octet;
    else if (octet < 224) length = ((octet - 192) << 8) + (bytes[at++] ?? 0) + 192;
    else if (octet === 255) {
      length = bytes.readUInt32BE(at);
      at += 4;
    } else return undefined;
  } else {
    tag = (first >> 2) & 0x0f;
    const kind = first & 3;
    if (kind === 0) length = bytes[at++] ?? 0;
    else if (kind === 1) {
      length = bytes.readUInt16BE(at);
      at += 2;
    } else if (kind === 2) {
      length = bytes.readUInt32BE(at);
      at += 4;
    } else return undefined;
  }
  if (tag !== 2) return undefined;
  const issuer = issuerOf(bytes.subarray(at, at + length));
  return issuer === undefined ? undefined : `gpg:${issuer}`;
}

/** A stable name for the key that made a commit's signature, or undefined when the text is no signature this can read. */
export function signingKeyOf(signature: string): string | undefined {
  try {
    return signature.includes("BEGIN SSH SIGNATURE") ? sshKey(signature) : signature.includes("BEGIN PGP SIGNATURE") ? pgpKey(signature) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The signing key of each signed commit in `git log --format=raw` output, by SHA. A signature is the
 * `gpgsig` header: its lines continue with one leading space, and the headers end at the first blank line.
 */
export function signaturesIn(raw: string): Map<string, string> {
  const keys = new Map<string, string>();
  let sha: string | undefined;
  let signature: string[] | undefined;
  let inHeaders = false;
  const finish = () => {
    if (sha !== undefined && signature !== undefined) {
      const key = signingKeyOf(signature.join("\n"));
      if (key !== undefined) keys.set(sha, key);
    }
    signature = undefined;
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("commit ") && !inHeaders) {
      finish();
      sha = line.slice(7, 47);
      inHeaders = true;
      continue;
    }
    if (!inHeaders) continue;
    if (line === "") {
      finish();
      inHeaders = false;
    } else if (line.startsWith("gpgsig ")) {
      signature = [line.slice(7)];
    } else if (line.startsWith(" ") && signature !== undefined) {
      signature.push(line.slice(1));
    } else {
      finish();
    }
  }
  finish();
  return keys;
}
