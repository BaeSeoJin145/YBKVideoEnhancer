# YBK Video Enhancer

This project remains a static HTML, CSS, and JavaScript site. Video files are processed locally in the browser with FFmpeg WebAssembly; the WASM engine is loaded from jsDelivr on first export. No video is uploaded to a server.

The browser pipeline uses FFmpeg's motion-compensated `minterpolate` filter, Lanczos resize, CAS sharpening, and `eq` color adjustment. It can export MP4, MOV, and MKV with an encoder included in the downloaded WASM build. The WASM input limit is about 2 GB and 4K/8K processing can require substantial memory and time.

This is not algorithm-for-algorithm identical to `interpolate_video.py`: the Python file uses OpenCV DIS optical flow while the static site uses FFmpeg MCI. Exact OpenCV DIS parity would require a custom browser-side OpenCV/WASM build; this static version intentionally does not add a processing server.

The HTML includes Open Graph and Twitter share text plus the company logo image. Replace the relative image URL with the deployed absolute public URL if the static host's social-preview crawler requires it.
