data = open("_chunk_play.js", encoding="utf-8").read()
for needle in ("preload", "isClipPreloaded", "shouldPlay", "silentAudio"):
    print("\n====", needle, data.count(needle))
    start = 0
    shown = 0
    while shown < 3:
        pos = data.find(needle, start)
        if pos < 0:
            break
        print(data[max(0, pos - 80): pos + 160].replace("\n", " "))
        print("---")
        start = pos + len(needle)
        shown += 1
