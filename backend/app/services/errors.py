"""Errors raised by the services. ``code`` is the contract's problem code."""

from __future__ import annotations


class ServiceError(Exception):
    code = "service_error"


class UnknownModel(ServiceError):
    code = "unknown_model"


class UnknownUseCase(ServiceError):
    code = "unknown_use_case"


class UnknownConcept(ServiceError):
    code = "unknown_concept"


class InvalidLens(ServiceError):
    code = "invalid_lens"
