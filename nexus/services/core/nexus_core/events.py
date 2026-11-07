"""In-process publish/subscribe event bus, fanned out to WebSocket clients.

Both desktop windows (main + floating assistant) subscribe to the same stream,
which is how they share live task / conversation state.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from .util import now_iso

log = logging.getLogger(__name__)


@dataclass(eq=False)  # identity hashing so subscribers can live in a set
class Subscriber:
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=1000))
    topics: set[str] | None = None  # None = everything
    dropped: int = 0


class EventBus:
    def __init__(self) -> None:
        self._subs: set[Subscriber] = set()

    def subscribe(self, topics: set[str] | None = None) -> Subscriber:
        sub = Subscriber(topics=topics)
        self._subs.add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subs.discard(sub)

    @property
    def subscriber_count(self) -> int:
        return len(self._subs)

    def publish(self, topic: str, data: dict[str, Any]) -> None:
        event = {"topic": topic, "ts": now_iso(), "data": data}
        prefix = topic.split(".", 1)[0]
        for sub in list(self._subs):
            if sub.topics is not None and topic not in sub.topics and prefix not in sub.topics:
                continue
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                # Slow consumer: drop the oldest event rather than block producers.
                try:
                    sub.queue.get_nowait()
                    sub.queue.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
                sub.dropped += 1

