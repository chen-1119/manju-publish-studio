"""Display a local Quark login QR image and keep the login session on this computer."""

import importlib
import os
from pathlib import Path

import qrcode
from quark_client.auth.login import QuarkAuth


config_dir = Path(os.environ["QUARK_CONFIG_DIR"])
config_dir.mkdir(parents=True, exist_ok=True)
qr_path = config_dir / "login-qr.png"


def save_qr(url):
    qrcode.make(url).save(qr_path)
    print("QR_READY", flush=True)


api_login = importlib.import_module("quark_client.auth.api_login")
api_login.display_qr_from_url = save_qr

try:
    QuarkAuth(timeout=300).login(force_relogin=True, method="api")
    print("LOGIN_OK", flush=True)
finally:
    qr_path.unlink(missing_ok=True)
    (config_dir / "login_result.json").unlink(missing_ok=True)
    (config_dir / "user_info.json").unlink(missing_ok=True)
