"""The `workpaper` command.

    workpaper serve [--host H] [--port P]   the app, the shared journal and the AI agents
    workpaper build-findings                 write web/data/findings.json for the static app
    workpaper report [--check] [--json]      the 20 issues and the net effect; --check guards the published figures
    workpaper eval --yes                     score the AI preparer blind against the known issues (spends API credit)
"""
from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='workpaper', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    s = sub.add_parser('serve', help='run the server (app, shared journal, AI agents)')
    s.add_argument('--host', default='127.0.0.1')
    s.add_argument('--port', type=int, default=8002)
    s.add_argument('--reload', action='store_true', help='restart on code changes (development)')

    sub.add_parser('build-findings', help='write web/data/findings.json for the static app')
    sub.add_parser('report', help='the issues the checks find and their effect', add_help=False)
    sub.add_parser('eval', help='evaluate the AI preparer (spends API credit)', add_help=False)

    args, rest = ap.parse_known_args(argv)
    if args.cmd == 'serve':
        import uvicorn
        uvicorn.run('workpaper.server.app:app', host=args.host, port=args.port, reload=args.reload)
        return 0
    if args.cmd == 'build-findings':
        from .config import FINDINGS_PATH
        from .findings import write
        data = write()
        print(f"{FINDINGS_PATH}: {len(data['points'])} points, {len(data['sets'])} distinct finding sets")
        return 0
    if args.cmd == 'report':
        from .report import main as report_main
        return report_main(rest)
    if args.cmd == 'eval':
        from .agents.evaluate import main as eval_main
        return eval_main(rest)
    return 2


if __name__ == '__main__':
    sys.exit(main())
