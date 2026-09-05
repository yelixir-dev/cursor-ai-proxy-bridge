"""Python 3: kqueue on Darwin; pidfd_open (Python 3.9+, Linux 5.3+) on Linux."""
import contextlib
import json
import os
import select
import selectors
import signal
import subprocess
import sys
import time


def members(group):
    snapshot = subprocess.check_output(["ps", "-axo", "pid=,pgid=,stat="], text=True)
    # Zombies have terminated; waiting for an unrelated reaper is not cleanup.
    return {int(pid) for pid, pgid, state in map(str.split, snapshot.splitlines())
            if int(pgid) == group and not state.startswith("Z")}


def terminate(group):
    if group <= 1 or group == os.getpgrp():
        raise ValueError("invalid_owned_group")
    with contextlib.ExitStack() as stack:
        pending = members(group)
        observed = sorted(pending)
        if sys.platform == "darwin":
            queue = stack.enter_context(contextlib.closing(select.kqueue()))
            for pid in list(pending):
                try:
                    queue.control([select.kevent(pid, filter=select.KQ_FILTER_PROC,
                                  flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                  fflags=select.KQ_NOTE_EXIT)], 0, 0)
                except ProcessLookupError:
                    pending.remove(pid)
            def exits(timeout):
                return [event.ident for event in queue.control(None, len(pending), timeout)]
        elif sys.platform == "linux":
            queue = stack.enter_context(selectors.DefaultSelector())
            for pid in list(pending):
                try:
                    fd = os.pidfd_open(pid)
                except ProcessLookupError:
                    pending.remove(pid)
                    continue
                stack.callback(os.close, fd)
                queue.register(fd, selectors.EVENT_READ, pid)
            def exits(timeout):
                events = queue.select(timeout)
                for key, _ in events:
                    queue.unregister(key.fd)
                return [key.data for key, _ in events]
        else:
            raise RuntimeError("unsupported_process_exit_platform")
        # All exit subscriptions precede the signal; never signal individual PIDs.
        try:
            if pending:
                os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 3
        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            pending.difference_update(exits(remaining))
        return {"observedPids": observed, "remainingPids": sorted(members(group))}


if __name__ == "__main__":
    print(json.dumps(terminate(int(sys.argv[1]))))
