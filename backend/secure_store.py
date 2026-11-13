"""Encryption at rest for the meeting database (SQLCipher, AES-256).

The 256-bit key is random and lives in the OS credential store (macOS Keychain, Windows Credential
Locker, Linux Secret Service) via `keyring`, never next to the data. On macOS the Keychain item is
bound to the backend's Python executable: other apps trigger a Keychain access prompt.
ELOQUENT_DB_KEY (64 hex chars) overrides the key, e.g. for headless setups.

On startup `encrypt_existing_database()` converts a plaintext database in place (verified copy first,
then the plaintext is overwritten and deleted), and the legacy per-meeting transcript files are
imported into the encrypted database by database.import_legacy_files().
"""
import hashlib
import logging
import os
import re
import secrets
import sqlite3
from functools import lru_cache
from pathlib import Path

from sqlcipher3 import dbapi2

logger = logging.getLogger(__name__)

KEYRING_SERVICE = "Eloquent Coach"
KEYRING_ACCOUNT = "database-key"
STATE_DIR = Path(os.environ.get("ELOQUENT_STATE_DIR", Path.home() / ".eloquent-coach"))
FALLBACK_KEY_FILE = STATE_DIR / "db.key"   # only when no OS credential store is available
PLAINTEXT_HEADER = b"SQLite format 3\x00"
_HEX_KEY = re.compile(r"^[0-9a-fA-F]{64}$")


class KeyUnavailable(RuntimeError):
    pass


def is_plaintext(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(16) == PLAINTEXT_HEADER
    except FileNotFoundError:
        return False


def _has_data(path: str) -> bool:
    return os.path.isfile(path) and os.path.getsize(path) > 0


def _keyring_get(account: str = KEYRING_ACCOUNT) -> str | None:
    try:
        import keyring
        return keyring.get_password(KEYRING_SERVICE, account)
    except Exception as err:  # noqa: BLE001 - no usable credential store
        logger.warning(f"OS credential store unavailable: {err}")
        return None


def _keyring_set(key: str, account: str = KEYRING_ACCOUNT) -> bool:
    try:
        import keyring
        keyring.set_password(KEYRING_SERVICE, account, key)
        return keyring.get_password(KEYRING_SERVICE, account) == key
    except Exception as err:  # noqa: BLE001
        logger.warning(f"Could not save '{account}' to the OS credential store: {err}")
        return False


def _write_private(path: Path, text: str) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def get_secret(account: str) -> str | None:
    """A small secret (e.g. the LLM server's API key): OS credential store, else an owner-only file."""
    value = _keyring_get(account)
    fallback = STATE_DIR / account
    if not value and fallback.is_file():
        value = fallback.read_text().strip()
    return value or None


def set_secret(account: str, value: str | None) -> None:
    """Store, or with a falsy value delete, a secret."""
    fallback = STATE_DIR / account
    if not value:
        try:
            import keyring
            keyring.delete_password(KEYRING_SERVICE, account)
        except Exception:  # noqa: BLE001 - not stored there
            pass
        _remove(str(fallback))
        return
    if _keyring_set(value, account):
        _remove(str(fallback))
    else:
        _write_private(fallback, value)


def key_store() -> str:
    """Where the key comes from, for the storage view."""
    if os.environ.get("ELOQUENT_DB_KEY"):
        return "ELOQUENT_DB_KEY environment variable"
    if FALLBACK_KEY_FILE.is_file():
        return f"Key file {FALLBACK_KEY_FILE}"
    try:
        import keyring
        return {"macOS": "macOS Keychain", "Windows": "Windows Credential Locker"}.get(
            type(keyring.get_keyring()).__module__.rsplit(".", 1)[-1], "OS credential store")
    except Exception:  # noqa: BLE001
        return "OS credential store"


@lru_cache(maxsize=1)
def database_key(db_path: str) -> str:
    """The 64-hex-char key. A new key is only ever created when there is no encrypted data it would orphan."""
    env = os.environ.get("ELOQUENT_DB_KEY", "").strip()
    if env:
        if not _HEX_KEY.match(env):
            raise KeyUnavailable("ELOQUENT_DB_KEY must be 64 hex characters (a 256-bit key).")
        return env.lower()
    key = _keyring_get()
    if not key and FALLBACK_KEY_FILE.is_file():
        key = FALLBACK_KEY_FILE.read_text().strip()
    if key:
        if not _HEX_KEY.match(key):
            raise KeyUnavailable("The stored database key is malformed.")
        return key.lower()
    if _has_data(db_path) and not is_plaintext(db_path):
        raise KeyUnavailable(
            f"The database at {db_path} is encrypted but its key isn't in the {key_store()} "
            f"(service '{KEYRING_SERVICE}', account '{KEYRING_ACCOUNT}'). Restore the key or set ELOQUENT_DB_KEY.")
    key = secrets.token_hex(32)
    if not _keyring_set(key):
        _write_private(FALLBACK_KEY_FILE, key)
        logger.warning(f"No OS credential store; the database key was saved to {FALLBACK_KEY_FILE} (owner-only).")
    return key


def _apply_key(conn, key: str) -> None:
    conn.execute(f"PRAGMA key = \"x'{key}'\"")   # raw 256-bit key: no passphrase derivation


def connect(db_path: str):
    """DB-API connection to the encrypted database (used as the SQLAlchemy engine's creator)."""
    conn = dbapi2.connect(db_path, check_same_thread=False)
    _apply_key(conn, database_key(db_path))
    return conn


def restrict_permissions(*paths: str) -> None:
    for p in paths:
        if os.path.exists(p):
            try:
                os.chmod(p, 0o600)
            except OSError as err:
                logger.warning(f"Could not restrict permissions on {p}: {err}")


def wipe_file(path: str) -> None:
    """Overwrite a file with zeros, then delete it. Best effort: SSDs, APFS snapshots and backups
    (e.g. Time Machine) may still hold older copies."""
    try:
        size = os.path.getsize(path)
        with open(path, "r+b", buffering=0) as f:
            chunk = b"\x00" * (1 << 20)
            left = size
            while left > 0:
                n = min(left, len(chunk))
                f.write(chunk[:n])
                left -= n
            os.fsync(f.fileno())
    except OSError as err:
        logger.warning(f"Could not overwrite {path} before deleting it: {err}")
    os.remove(path)


def _remove(path: str) -> None:
    if os.path.exists(path):
        os.remove(path)


def _table_counts(conn) -> dict[str, int]:
    names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    return {n: conn.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0] for n in names}


def verify(db_path: str, key: str, expected_counts: dict[str, int] | None = None) -> None:
    conn = dbapi2.connect(db_path)
    try:
        _apply_key(conn, key)
        problems = [r[0] for r in conn.execute("PRAGMA cipher_integrity_check")]
        if problems:
            raise RuntimeError(f"Encrypted database failed its integrity check: {problems[:3]}")
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Encrypted database failed SQLite's integrity check.")
        if expected_counts is not None and _table_counts(conn) != expected_counts:
            raise RuntimeError("Encrypted copy doesn't contain the same rows as the original.")
    finally:
        conn.close()


def encrypt_existing_database(db_path: str) -> bool:
    """Encrypt a plaintext database in place. Returns True if anything was converted.

    Order is crash-safe: the encrypted copy is fully verified before the plaintext is moved aside,
    and a leftover `.plaintext` file is only wiped once the encrypted database opens with the key."""
    tmp, aside = db_path + ".encrypting", db_path + ".plaintext"
    for p in (tmp, tmp + "-wal", tmp + "-shm", tmp + "-journal"):
        _remove(p)

    if os.path.exists(aside):   # interrupted earlier run
        if _has_data(db_path) and not is_plaintext(db_path):
            verify(db_path, database_key(db_path))
            wipe_file(aside)
            return True
        _remove(db_path)
        os.rename(aside, db_path)

    if not is_plaintext(db_path):
        return False

    plain = sqlite3.connect(db_path)
    try:
        plain.execute("PRAGMA wal_checkpoint(TRUNCATE)")   # fold the WAL into the main file first
        counts = _table_counts(plain)
        user_version = plain.execute("PRAGMA user_version").fetchone()[0]
    finally:
        plain.close()

    key = database_key(db_path)
    conn = dbapi2.connect(db_path)   # no key: reads the plaintext file
    try:
        conn.execute("ATTACH DATABASE ? AS encrypted KEY ?", (tmp, f"x'{key}'"))
        conn.execute("SELECT sqlcipher_export('encrypted')")
        conn.execute(f"PRAGMA encrypted.user_version = {int(user_version)}")
        conn.execute("DETACH DATABASE encrypted")
    finally:
        conn.close()
    restrict_permissions(tmp)
    verify(tmp, key, counts)

    os.rename(db_path, aside)
    for p in (db_path + "-wal", db_path + "-shm"):
        if os.path.exists(p):
            wipe_file(p)
    os.replace(tmp, db_path)
    wipe_file(aside)
    logger.info(f"Encrypted the meeting database ({sum(counts.values())} rows) with SQLCipher.")
    return True


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
