"""Install the native extension module over the stock Aethonan one.

The extension module built by this crate is a drop-in replacement of the one
shipped with the Aethonan package: the Python side is entirely stock
Aethonan, while the native routes are provided by this crate.
"""

import pathlib
import shutil
import sys

import aethonan


def main() -> None:
    if len(sys.argv) < 2:
        print(f'usage: {sys.argv[0]} <path to the built extension module>')
        raise SystemExit(1)

    source = pathlib.Path(sys.argv[1]).resolve()
    if not source.is_file():
        print(f'{source} does not exist')
        raise SystemExit(1)

    package = pathlib.Path(aethonan.__path__[0])
    for existing in package.glob('_aethonan*.so'):
        existing.unlink()

    target = package / '_aethonan.so'
    # Write to a temporary file and rename it, so that a running server
    # keeps its own copy of the module instead of crashing on the replaced
    # file.
    temporary = package / '_aethonan.so.new'
    shutil.copy(source, temporary)
    temporary.replace(target)
    print(f'installed {target}')


if __name__ == '__main__':
    main()
