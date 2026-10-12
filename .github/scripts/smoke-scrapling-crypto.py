"""Verify the platform wheel and JWT capabilities shipped in the release."""
import json
from pathlib import Path
import platform
import sys

sys.path.insert(0, str(Path(sys.argv[1]) / "packages"))
import cryptography
import jwt
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa

expected = "48.0.1" if sys.platform == "darwin" and platform.machine() == "x86_64" else "50.0.2"
assert cryptography.__version__ == expected, f"Unexpected cryptography version: {cryptography.__version__}"
algorithms = []
for algorithm, new_key in (
    ("RS256", lambda: rsa.generate_private_key(public_exponent=65537, key_size=2048)),
    ("ES256", lambda: ec.generate_private_key(ec.SECP256R1())),
    ("EdDSA", ed25519.Ed25519PrivateKey.generate),
):
    key = new_key()
    token = jwt.encode({"sub": "release-check"}, key, algorithm=algorithm)
    assert jwt.decode(token, key.public_key(), algorithms=[algorithm])["sub"] == "release-check"
    try:
        jwt.decode(token, new_key().public_key(), algorithms=[algorithm])
    except jwt.InvalidSignatureError:
        pass
    else:
        raise AssertionError(f"{algorithm} accepted an invalid signature")
    algorithms.append(algorithm)
print(json.dumps({"cryptography": cryptography.__version__, "pyjwt": jwt.__version__, "jwt_algorithms": algorithms, "invalid_signatures_rejected": len(algorithms)}))
