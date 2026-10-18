#!/usr/bin/env python3
"""
🎬 8K Ultra-HD Video Enhancement & Motion Interpolation Script
Optimized for Apple Silicon (Mac M4 Pro / VideoToolbox Hardware Acceleration)

Features:
- Moderate Frame Interpolation: DIS Optical Flow (60fps sweet-spot: silky smooth & efficient)
- 8K UHD Upscaling: 7680 x 4320 via High-Fidelity Lanczos4 Resampling
- Contrast-Adaptive Sharpening (AMD CAS): Razor-sharp edge & texture clarity without ringing
- Color & Vibrance Tuning: Rich saturation (+18%), punchy dynamic contrast (+6%), highlights
- Apple Silicon M4 Pro Hardware Encoding: hevc_videotoolbox (H.265 80M, hvc1 Apple/YouTube tagged)
- Lossless Audio Preservation: Direct stream copy of original high-fidelity audio
"""

import os
import sys
import argparse
import subprocess
import signal
import cv2
import numpy as np
from tqdm import tqdm

def check_encoder_support():
    """Checks VideoToolbox hardware encoder support."""
    try:
        res = subprocess.run(['ffmpeg', '-encoders'], capture_output=True, text=True)
        has_hevc = 'hevc_videotoolbox' in res.stdout
        has_h264 = 'h264_videotoolbox' in res.stdout
        return has_hevc, has_h264
    except Exception:
        return False, False

def interpolate_frames(f1, f2, alpha, dis, grid_x, grid_y, scale, w, h):
    """
    Computes bidirectional optical flow between f1 and f2,
    and returns motion-compensated intermediate frame at timestamp alpha in (0, 1).
    """
    sw, sh = int(w * scale), int(h * scale)
    g1 = cv2.cvtColor(cv2.resize(f1, (sw, sh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(cv2.resize(f2, (sw, sh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)

    flow_fwd = dis.calc(g1, g2, None)
    flow_bwd = dis.calc(g2, g1, None)

    flow_fwd_full = cv2.resize(flow_fwd, (w, h), interpolation=cv2.INTER_LINEAR) * (1.0 / scale)
    flow_bwd_full = cv2.resize(flow_bwd, (w, h), interpolation=cv2.INTER_LINEAR) * (1.0 / scale)

    # Warp f1 forward towards f2
    map1_x = grid_x + flow_bwd_full[..., 0] * alpha
    map1_y = grid_y + flow_bwd_full[..., 1] * alpha
    warp1 = cv2.remap(f1, map1_x, map1_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

    # Warp f2 backward towards f1
    map2_x = grid_x + flow_fwd_full[..., 0] * (1.0 - alpha)
    map2_y = grid_y + flow_fwd_full[..., 1] * (1.0 - alpha)
    warp2 = cv2.remap(f2, map2_x, map2_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

    # Smooth linear blend between both motion-compensated warps
    return cv2.addWeighted(warp1, 1.0 - alpha, warp2, alpha, 0.0)

def main():
    parser = argparse.ArgumentParser(
        description="🎬 8K Ultra-HD Video Enhancement & Motion Interpolator (Apple Silicon Optimized)"
    )
    parser.add_argument("--input", "-i", type=str, default="video.mp4",
                        help="Path to input video file (default: video.mp4)")
    parser.add_argument("--output", "-o", type=str, default="",
                        help="Path to output video file (default: auto generated)")
    parser.add_argument("--res", "-r", type=str, default="8k", choices=["8k", "4k", "original"],
                        help="Target output resolution: 8k (7680x4320), 4k (3840x2160), or original (default: 8k)")
    parser.add_argument("--fps", "-f", type=int, default=60,
                        help="Target frame rate (default: 60 fps for moderate, smooth interpolation)")
    parser.add_argument("--sharpness", "-s", type=float, default=0.55,
                        help="CAS (Contrast Adaptive Sharpening) strength 0.0 ~ 1.0 (default: 0.55)")
    parser.add_argument("--saturation", "-sat", type=float, default=1.18,
                        help="Color saturation multiplier (default: 1.18 = +18%% vivid boost)")
    parser.add_argument("--contrast", "-con", type=float, default=1.06,
                        help="Contrast adjustment multiplier (default: 1.06 = +6%% punchy depth)")
    parser.add_argument("--brightness", "-bri", type=float, default=0.01,
                        help="Brightness adjustment offset (default: 0.01)")
    parser.add_argument("--bitrate", "-b", type=str, default="",
                        help="Video encoding bitrate (default: 80M for 8K, 45M for 4K)")
    parser.add_argument("--preset", type=str, choices=["fast", "medium", "ultra"], default="medium",
                        help="Optical flow precision: fast (fastest), medium (recommended), ultra (finest)")
    parser.add_argument("--max-frames", type=int, default=0,
                        help="Limit processing to first N source frames (0 = entire video)")
    args = parser.parse_args()

    input_path = os.path.abspath(args.input)
    if not os.path.isfile(input_path):
        print(f"❌ Error: Input video file not found at: {input_path}")
        sys.exit(1)

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(f"❌ Error: Failed to open input video: {input_path}")
        sys.exit(1)

    src_fps = cap.get(cv2.CAP_PROP_FPS)
    total_src_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration = total_src_frames / src_fps if src_fps > 0 else 0

    if args.max_frames > 0 and args.max_frames < total_src_frames:
        total_src_frames = args.max_frames
        duration = total_src_frames / src_fps

    # Calculate interpolation ratio
    target_fps = args.fps
    if target_fps <= src_fps:
        ratio = 1
        actual_target_fps = src_fps
    else:
        ratio = round(target_fps / src_fps)
        if ratio < 1:
            ratio = 1
        actual_target_fps = src_fps * ratio

    total_target_frames = (total_src_frames - 1) * ratio + 1 if ratio > 1 else total_src_frames

    # Determine resolution
    if args.res == "8k":
        out_w, out_h = 7680, 4320
        res_label = "8K UHD (7680x4320)"
        default_bitrate = "80M"
    elif args.res == "4k":
        out_w, out_h = 3840, 2160
        res_label = "4K UHD (3840x2160)"
        default_bitrate = "45M"
    else:
        out_w, out_h = width, height
        res_label = f"Original ({out_w}x{out_h})"
        default_bitrate = "40M"

    bitrate = args.bitrate if args.bitrate else default_bitrate

    # Generate output filename
    if not args.output:
        base_name, _ = os.path.splitext(os.path.basename(input_path))
        fps_tag = f"{int(round(actual_target_fps))}fps"
        res_tag = args.res.lower()
        output_path = os.path.join(os.path.dirname(input_path), f"{base_name}_{res_tag}_{fps_tag}_enhanced.mp4")
    else:
        output_path = os.path.abspath(args.output)

    # Check encoder support
    has_hevc, has_h264 = check_encoder_support()
    if has_hevc:
        encoder = "hevc_videotoolbox"
        encoder_label = "Apple VideoToolbox HEVC (Hardware ⚡)"
    elif has_h264 and args.res != "8k":
        encoder = "h264_videotoolbox"
        encoder_label = "Apple VideoToolbox H.264 (Hardware ⚡)"
    else:
        encoder = "libx265"
        encoder_label = "libx265 (CPU)"

    print("=" * 65)
    print("🎬 8K Ultra-HD Video Enhancement & Motion Interpolator")
    print("   Optimized for Apple Silicon M4 Pro / Hardware VideoToolbox")
    print("=" * 65)
    print(f"• Input Video     : {os.path.basename(input_path)}")
    print(f"• Source Specs    : {width}x{height} @ {src_fps:.2f} fps ({total_src_frames} frames, {duration:.1f}s)")
    print(f"• Target Output   : {res_label} @ {actual_target_fps:.2f} fps ({ratio}x interpolation)")
    print(f"• Total Output    : ~{total_target_frames} frames")
    print(f"• Visual Tuning   : CAS Sharpness: {args.sharpness:.2f} | Saturation: {args.saturation:.2f}x | Contrast: {args.contrast:.2f}x")
    print(f"• Encoding Spec   : {encoder} | Target Bitrate: {bitrate} (hvc1 tagged)")
    print(f"• Target File     : {output_path}")
    print("=" * 65)

    # Build FFmpeg filter chain
    filters = [
        "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"
    ]
    # 1. High-precision Lanczos4 upscaler
    if (out_w, out_h) != (width, height):
        filters.append(f"scale={out_w}:{out_h}:flags=lanczos+accurate_rnd")
    # 2. Contrast-Adaptive Sharpening (CAS)
    if args.sharpness > 0:
        filters.append(f"cas={args.sharpness:.2f}")
    # 3. Saturation, Contrast, Brightness adjustment
    filters.append(f"eq=contrast={args.contrast:.2f}:brightness={args.brightness:.2f}:saturation={args.saturation:.2f}")
    vf_str = ",".join(filters)

    # Temporary intermediate video file for multiplexing
    temp_video = output_path + ".temp.mp4"

    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-s", f"{width}x{height}",
        "-pix_fmt", "bgr24",
        "-r", str(actual_target_fps),
        "-i", "-",
        "-vf", vf_str,
        "-c:v", encoder,
    ]

    if "videotoolbox" in encoder:
        ffmpeg_cmd.extend([
            "-b:v", bitrate,
            "-maxrate", "120M" if args.res == "8k" else "60M",
            "-spatial_aq", "1",
            "-tag:v", "hvc1",
            "-pix_fmt", "yuv420p"
        ])
    else:
        ffmpeg_cmd.extend([
            "-crf", "18",
            "-preset", "medium",
            "-tag:v", "hvc1",
            "-pix_fmt", "yuv420p"
        ])

    ffmpeg_cmd.append(temp_video)

    proc = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def cleanup():
        if proc.poll() is None:
            proc.kill()
        if os.path.exists(temp_video):
            try:
                os.remove(temp_video)
            except Exception:
                pass

    # Initialize Optical Flow Engine if interpolating
    dis = None
    grid_x, grid_y = None, None
    scale = 0.5
    if ratio > 1:
        if args.preset == "fast":
            preset_val = cv2.DISOPTICAL_FLOW_PRESET_FAST
            scale = 0.5
        elif args.preset == "ultra":
            preset_val = cv2.DISOPTICAL_FLOW_PRESET_ULTRAFINE
            scale = 0.75
        else:
            preset_val = cv2.DISOPTICAL_FLOW_PRESET_MEDIUM
            scale = 0.5

        dis = cv2.DISOpticalFlow_create(preset_val)
        grid_x, grid_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))

    ret, prev_frame = cap.read()
    if not ret:
        print("❌ Error: Could not read first frame from video.")
        cap.release()
        cleanup()
        sys.exit(1)

    pbar = tqdm(total=total_target_frames, unit="frame", desc="⚡ Processing & Upscaling")

    try:
        # Write first frame
        proc.stdin.write(prev_frame.tobytes())
        pbar.update(1)

        frame_idx = 1
        while frame_idx < total_src_frames:
            ret, curr_frame = cap.read()
            if not ret:
                break

            if ratio > 1:
                # Generate (ratio - 1) intermediate frames
                for k in range(1, ratio):
                    alpha = k / float(ratio)
                    interp_frame = interpolate_frames(prev_frame, curr_frame, alpha, dis, grid_x, grid_y, scale, width, height)
                    proc.stdin.write(interp_frame.tobytes())
                    pbar.update(1)

            # Write current keyframe
            proc.stdin.write(curr_frame.tobytes())
            pbar.update(1)

            prev_frame = curr_frame
            frame_idx += 1

    except (KeyboardInterrupt, BrokenPipeError):
        print("\n⚠️ Interrupted by user. Cleaning up...")
        pbar.close()
        cap.release()
        cleanup()
        sys.exit(1)

    pbar.close()
    cap.release()
    proc.stdin.close()
    proc.wait()

    # Audio Muxing
    print("\n🎵 Merging original high-fidelity audio stream...")
    mux_cmd = [
        "ffmpeg", "-y",
        "-i", temp_video,
        "-i", input_path,
        "-c:v", "copy",
        "-c:a", "copy",
        "-map", "0:v:0",
        "-map", "1:a:0?",
        "-tag:v", "hvc1",
        "-shortest",
        output_path
    ]
    subprocess.run(mux_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    if os.path.exists(temp_video):
        os.remove(temp_video)

    if os.path.exists(output_path):
        out_size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print("=" * 65)
        print("🎉 Enhancement & Interpolation Completed Successfully!")
        print(f"• Output File : {output_path}")
        print(f"• File Size   : {out_size_mb:.1f} MB")
        print(f"• Resolution  : {out_w}x{out_h} ({args.res.upper()})")
        print(f"• Frame Rate  : {actual_target_fps:.2f} fps")
        print(f"• Codec       : HEVC (hvc1, QuickTime & YouTube 8K Ready)")
        print("=" * 65)
    else:
        print("❌ Error occurred during final video creation.")

if __name__ == "__main__":
    main()
