#!/usr/bin/env python3
"""Surface-specific verification runner for extension repo."""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CORE_SURFACES = ["syntax", "privacy", "unit_tests", "dataclasses", "handler_count", "harness_smoke"]
RELEASE_SURFACES = ["release_packages", "firefox_lint"]


def package_version():
    return subprocess.check_output(
        ["node", "-p", "require('./package.json').version"],
        cwd=ROOT,
        text=True
    ).strip()


def surface_commands():
    version = package_version()
    firefox_stage = f"web-ext-artifacts/stage-firefox-{version}"
    return {
        "syntax": [
            "bash -c 'for f in $(find . \\( -name \"*.js\" -o -name \"*.mjs\" \\) -not -path \"*/lib/*\" -not -path \"*/node_modules/*\" -not -path \"*/web-ext-artifacts/*\" -not -path \"*/playwright-report/*\" -not -path \"*/test-results/*\"); do node --check \"$f\" || exit 1; done'"
        ],
        "privacy": ["npm run audit"],
        "unit_tests": ["npm test"],
        "dataclasses": ["node scripts/check-dataclasses.js"],
        "handler_count": ["npm run check:handlers"],
        # The harness smoke test exercises claim/release/loop/reap/prune
        # against a noop worker. It uses HARNESS_SMOKE_MODE=1 so it does
        # not recursively invoke verify:all -- safe to include here.
        "harness_smoke": ["npm run test:harness"],
        "release_packages": ["bash -c 'npm run release:all && npm run check:release-packages'"],
        "firefox_lint": [
            f"bash -c 'npm run release:firefox && npx --no-install web-ext lint --source-dir {firefox_stage} --warnings-as-errors'"
        ],
    }


GROUPS = {
    "quick": CORE_SURFACES,
    "release": RELEASE_SURFACES,
    "all": CORE_SURFACES + RELEASE_SURFACES,
}


def run_surface(name):
    commands_by_surface = surface_commands()
    if name in GROUPS:
        results = {}
        for surface in GROUPS[name]:
            results[surface] = run_surface(surface)
        return all(results.values())
    commands = commands_by_surface.get(name, [])
    if not commands:
        print(f"Unknown surface: {name}", file=sys.stderr)
        return False
    for cmd in commands:
        result = subprocess.run(cmd, shell=True, cwd=ROOT)
        if result.returncode != 0:
            print(f"FAIL: {name} -- {cmd}", file=sys.stderr)
            return False
    print(f"PASS: {name}")
    return True

if __name__ == "__main__":
    surface = sys.argv[1] if len(sys.argv) > 1 else "all"
    sys.exit(0 if run_surface(surface) else 1)
