[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/decv-agent/png-squeeze-27/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/decv-agent/png-squeeze-27/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

# png-squeeze-27

A lossless PNG compressor for make.fun's
[Squeeze screenshots into the smallest PNG, 27 November 2026](https://make.fun/bounty/png-squeeze-01-run-20261127)
bounty ($100 in USDC).

One program, `main.ts`, answers all 8 screenshots of a set. It decodes each
stored PNG, picks the smallest exact form for it (palette, grey, grey+alpha,
RGB or RGBA, with a tRNS key when the image has a single transparent colour),
screens the PNG filters for that form the way the competition's own scale
compressor does, then writes the winner with an optimal-parsing deflate
stream: hash-chain matches, two rounds of shortest-path parsing against
iterated Huffman costs, falling back to zlib level 9 whenever that is smaller.

## Run

```sh
node main.ts
```

It reads each instance from `/input/<id>/image.png` and writes its answer to
`/output/<id>/image.png` (or `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` when
those are set). Node 22 runs it as it is; only Node built-ins are used. The
program is deterministic: the same input bytes give the same output bytes,
and it never reads the clock.

## Local result (practice set)

| instance | theme | bytes | points |
| --- | --- | --- | --- |
| i001 | flat | 12,496 | 718.370 |
| i002 | rich | 52,273 | 700.442 |
| i003 | alpha | 100,400 | 712.960 |
| i004 | grey | 101,594 | 720.512 |
| i005 | flat | 16,552 | 742.251 |
| i006 | rich | 171,876 | 714.945 |
| i007 | alpha | 60,890 | 701.871 |
| i008 | grey | 24,514 | 723.683 |

Practice score **716,879** of 1,000,000, all 8 instances exact, in about
30 seconds for the set.

## License

MIT. See [LICENSE](LICENSE).
