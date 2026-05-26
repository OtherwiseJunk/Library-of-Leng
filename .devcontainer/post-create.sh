#!/usr/bin/env bash
set -euo pipefail

npm install
npm install --prefix frontend

python3 -m pip install --user -r requirements.cpu.txt -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
python3 -m pip install --user -r requirements.txt

mkdir -p uploads
