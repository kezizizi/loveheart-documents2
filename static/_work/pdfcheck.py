"""Compare print-to-PDF output: the print stylesheet must reduce every view to the card alone."""
import re
import sys
import zlib


def pages(raw):
    n = len(re.findall(rb"/Type\s*/Page[^s]", raw))
    if n:
        return n
    m = re.findall(rb"/Count\s+(\d+)", raw)
    return max(int(x) for x in m) if m else 0


def mediaboxes(raw):
    return sorted(set(re.findall(rb"/MediaBox\s*\[([^\]]+)\]", raw)))


def decoded_text(raw):
    """Decompress Flate streams; return whatever literal text we can see."""
    out = []
    for m in re.finditer(rb"stream\r?\n(.*?)endstream", raw, re.S):
        try:
            out.append(zlib.decompress(m.group(1)))
        except Exception:
            pass
    return b"\n".join(out)


for path in sys.argv[1:]:
    raw = open(path, "rb").read()
    dec = decoded_text(raw)
    name = path.rsplit("\\", 1)[-1]
    print(f"--- {name}")
    print(f"    size      : {len(raw)/1024:.0f} KB")
    print(f"    pages     : {pages(raw)}")
    print(f"    mediabox  : {mediaboxes(raw)}")
    # 打印时应当被隐藏的界面元素，其文字不应出现在内容流里
    for probe in (b"CSV", b"PDF"):
        print(f"    contains {probe.decode():<4}: {probe in dec}")
