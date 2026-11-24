# YT Snap

Paste a YouTube link with a time (`?t=95`, `&t=1m35s`, `youtu.be/ID?t=95`), get three highest-resolution stills (one step before, at, and one step after that moment; 0.5 s by default) as lossless PNGs, pick the one where the expression or eye direction is right, then send it to OpenAI's image model with a preset prompt.

## How to use
The page has a **How to use** button in the header (it opens once on the first visit). In short: paste a link, press Capture 3 frames, pick the best frame, press Enhance, then compare and download.

## Run
```bash
cp .env.example .env      # add OPENAI_API_KEY
docker compose up --build
# open http://localhost:3000
```

## Change the prompts
Edit `prompts.json` (id, label, text) and restart. The UI shows each prompt read-only; the first one is the default.

## How it works
1. `yt-dlp -f bv* -j` picks the best video-only stream (highest resolution available).
2. `ffmpeg -ss <t> -i <stream> -frames:v 1` decodes one frame to PNG, so nothing is re-compressed.
3. The frame is letterboxed onto the nearest size the image model accepts (1536x1024, 1024x1536 or 1024x1024), sent to `/v1/images/edits` with `input_fidelity=high`, then cropped back to the original aspect ratio.

## Things to know
- The model works at most at 1536 px on the long edge, so the enhanced image is about 1536x864 for a 16:9 video. The tick box scales it back up with Lanczos, which adds size but not detail. For true 4K output, run the original through a dedicated upscaler instead (Real-ESRGAN, for example).
- Each enhance call costs money (high quality). Set `ACCESS_TOKEN` if the app is exposed.
- Age-restricted or members-only videos need cookies: mount a cookies.txt and add `--cookies /path/cookies.txt` to `YTDLP_EXTRA_ARGS`.
- Downloading from YouTube can conflict with its Terms of Service, and frames are the uploader's copyright. Use it for your own or permitted content.
- Files are deleted after 24 hours.
