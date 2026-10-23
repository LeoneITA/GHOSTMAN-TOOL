import json
import sys


def main():
    request = json.load(sys.stdin)
    text = request["text"].strip()
    result = {
        "text": text,
        "characters": len(text),
        "words": len(text.split()),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
