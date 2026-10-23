"""The one least-recently-used cache the derivation services and the store share."""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable, Hashable, Iterator
from typing import Generic, TypeVar

V = TypeVar("V")


class LruCache(Generic[V]):
    """Up to ``max_entries`` values, the least recently used one out first.

    ``get(key, build)`` returns the cached value (and marks it used) or builds,
    stores, and returns it. Not thread-safe: the API calls every service under
    ``Store.lock``.
    """

    def __init__(self, max_entries: int):
        self.max_entries = max_entries
        self._entries: OrderedDict[Hashable, V] = OrderedDict()

    def get(self, key: Hashable, build: Callable[[], V]) -> V:
        if key in self._entries:
            self._entries.move_to_end(key)
            return self._entries[key]
        value = self._entries[key] = build()
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)
        return value

    def peek(self, key: Hashable) -> V | None:
        """The cached value without marking it used, or None."""
        return self._entries.get(key)

    def discard(self, keep: Callable[[V], bool]) -> None:
        """Drop every value for which ``keep`` is false."""
        for key in [key for key, value in self._entries.items() if not keep(value)]:
            del self._entries[key]

    def clear(self) -> None:
        self._entries.clear()

    def values(self) -> Iterator[V]:
        return iter(self._entries.values())

    def __len__(self) -> int:
        return len(self._entries)
