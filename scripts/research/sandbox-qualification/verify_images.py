"""Verify fixed qualification downloads before creating the VM (requires PGPy)."""
import argparse
import hashlib
import json
from pathlib import Path

import pgpy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("downloads", type=Path)
    args = parser.parse_args()
    root = args.downloads.resolve(strict=True)
    expected = {
        "LIMA-SHA256SUMS": "5f9eaa93d2b58986273347d0f139b95f8fb87f117d98897760dee8d5b9d45ca6",
        "lima-2.3.0-Darwin-arm64.tar.gz": "b7af444bd8f91d3c307477e562f2cf3bd7595d62b9429185e4fa841563578cfc",
        "ubuntu-24.04-server-cloudimg-arm64.img": "50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e",
    }
    actual = {}
    for name, digest in expected.items():
        with (root / name).open("rb") as stream:
            actual[name] = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual[name] != digest:
            raise SystemExit(f"Checksum mismatch: {name}")
    key, _ = pgpy.PGPKey.from_file(str(root / "ubuntu-cloud-signing.asc"))
    if str(key.fingerprint) != "D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81":
        raise SystemExit("Unexpected Canonical cloud signing key")
    checksums = (root / "UBUNTU-SHA256SUMS").read_bytes()
    signature = pgpy.PGPSignature.from_file(str(root / "UBUNTU-SHA256SUMS.gpg"))
    if not key.verify(checksums, signature):
        raise SystemExit("Ubuntu checksum signature did not verify")
    image_name = "ubuntu-24.04-server-cloudimg-arm64.img"
    signed_digests = dict(line.replace(" *", " ").split() for line in checksums.decode().splitlines())
    if signed_digests.get(expected[image_name]) != image_name:
        raise SystemExit("Pinned image checksum missing from signed manifest")
    print(json.dumps({"verified": actual, "ubuntu_signer": str(key.fingerprint)}, indent=2))


if __name__ == "__main__":
    main()
