import pytest

from config import select_bind_host


def test_dev_mode_defaults_to_loopback():
    assert select_bind_host(True) == "127.0.0.1"


def test_production_defaults_to_all_interfaces_for_container_ingress():
    assert select_bind_host(False) == "0.0.0.0"


def test_non_loopback_dev_bind_fails_closed():
    with pytest.raises(RuntimeError, match="PAD_DEV_ALLOW_DANGEROUS_BIND"):
        select_bind_host(True, "0.0.0.0")


def test_non_loopback_dev_bind_requires_named_dangerous_opt_in():
    assert select_bind_host(True, "0.0.0.0", allow_dangerous_bind=True) == "0.0.0.0"
