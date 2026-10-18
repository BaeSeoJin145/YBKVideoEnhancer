(() => {
  const $ = (selector) => document.querySelector(selector);
  const video = $("#sourceVideo");
  const canvas = $("#previewCanvas");
  const fileInput = $("#fileInput");
  const dropZone = $("#dropZone");
  const emptyState = $("#emptyState");
  const toast = $("#toast");
  const state = { file: null, url: null, resolution: "8k", exporting: false, engineReady: false, ffmpeg: null, capabilities: null, stopped: false, original: false, raf: 0, toastTimer: 0, logLines: [] };
  const controls = {
    sharpness: $("#sharpness"),
    saturation: $("#saturation"),
    contrast: $("#contrast"),
    brightness: $("#brightness"),
    fps: $("#fpsSelect"),
    preset: $("#presetSelect"),
    format: $("#formatSelect"),
    codec: $("#codecSelect"),
    bitrate: $("#bitrateSelect"),
  };

  const vertexSource = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main() {
      vUv = (aPosition + 1.0) * 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;
  const fragmentSource = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uVideo;
    uniform vec2 uTexel;
    uniform float uSharpness;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uBrightness;
    uniform float uOriginal;
    void main() {
      vec4 center = texture2D(uVideo, vUv);
      vec3 color = center.rgb;
      if (uOriginal < 0.5) {
        vec3 neighbors = texture2D(uVideo, vUv + vec2(uTexel.x, 0.0)).rgb
                       + texture2D(uVideo, vUv - vec2(uTexel.x, 0.0)).rgb
                       + texture2D(uVideo, vUv + vec2(0.0, uTexel.y)).rgb
                       + texture2D(uVideo, vUv - vec2(0.0, uTexel.y)).rgb;
        vec3 soft = neighbors * 0.25;
        color = color + (color - soft) * uSharpness * 1.7;
        float gray = dot(color, vec3(0.299, 0.587, 0.114));
        color = mix(vec3(gray), color, uSaturation);
        color = (color - 0.5) * uContrast + 0.5 + uBrightness;
      }
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `;

  let gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
  let program = null;
  let texture = null;
  let uniforms = null;
  let fallbackContext = null;

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || "미리보기 셰이더를 준비할 수 없습니다.");
    }
    return shader;
  }

  if (gl) {
    try {
      const vertex = compileShader(gl.VERTEX_SHADER, vertexSource);
      const fragment = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "aPosition");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      uniforms = {
        texel: gl.getUniformLocation(program, "uTexel"),
        sharpness: gl.getUniformLocation(program, "uSharpness"),
        saturation: gl.getUniformLocation(program, "uSaturation"),
        contrast: gl.getUniformLocation(program, "uContrast"),
        brightness: gl.getUniformLocation(program, "uBrightness"),
        original: gl.getUniformLocation(program, "uOriginal"),
      };
    } catch (error) {
      console.warn("WebGL preview unavailable; using a basic canvas filter.", error);
      gl = null;
      program = null;
    }
  }
  if (!gl) fallbackContext = canvas.getContext("2d", { alpha: false });

  function notify(message, duration = 3200) {
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), duration);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "00:00";
    const value = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  function getOutputSize() {
    if (state.resolution === "original") return { width: video.videoWidth || 1920, height: video.videoHeight || 1080 };
    if (state.resolution === "4k") return { width: 3840, height: 2160 };
    return { width: 7680, height: 4320 };
  }

  function updateOutputSummary() {
    const dimensions = getOutputSize();
    const resolution = state.resolution === "original" ? "원본" : `${state.resolution.toUpperCase()} UHD`;
    const fps = controls.fps.value === "source" ? "원본 fps" : `${controls.fps.value} fps`;
    $("#outputSummary").innerHTML = `${resolution} <i>·</i> ${fps}`;
    $("#outputFormatBadge").textContent = controls.format.value.toUpperCase();
    const codecLabel = controls.codec.value === "auto" ? "코덱 자동" : controls.codec.value === "hevc" ? "H.265 / HEVC" : "H.264";
    const bitrateLabel = controls.bitrate.value || "자동 비트레이트";
    $("#outputDetails").textContent = `${codecLabel} · ${bitrateLabel} · WASM`;
    $("#resolutionNote").textContent = `최종 해상도 ${dimensions.width} × ${dimensions.height}`;
    $("#overlayResolution").textContent = `${dimensions.width} × ${dimensions.height}`;
    const longVideo = Number.isFinite(video.duration) && video.duration > 600;
    $("#exportFootnote").textContent = dimensions.width >= 7680 || longVideo
      ? "고해상도·긴 영상은 처리 시간이 길 수 있습니다."
      : "고해상도 영상은 처리 시간이 길 수 있습니다.";
  }

  function updateSlider(input, output, display, progress) {
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    output.textContent = display(value);
    input.style.setProperty("--range-progress", `${((value - min) / (max - min)) * 100}%`);
  }

  function syncControls() {
    updateSlider(controls.sharpness, $("#sharpnessValue"), (value) => String(value), true);
    updateSlider(controls.saturation, $("#saturationValue"), (value) => `${value}%`, true);
    updateSlider(controls.contrast, $("#contrastValue"), (value) => `${value}%`, true);
    updateSlider(controls.brightness, $("#brightnessValue"), (value) => `${value > 0 ? "+" : ""}${value}`, true);
    updateOutputSummary();
    if (state.file && video.readyState >= 2) drawFrame();
  }

  function refreshExportAvailability() {
    $("#exportButton").disabled = !state.file || state.exporting;
  }

  function setCanvasSize(forceOutput = false) {
    let { width, height } = forceOutput || state.exporting ? getOutputSize() : { width: video.videoWidth || 1280, height: video.videoHeight || 720 };
    if (!(forceOutput || state.exporting) && Math.max(width, height) > 1920) {
      const scale = 1920 / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      if (gl) gl.viewport(0, 0, width, height);
    }
  }

  function drawFrame() {
    if (!state.file || video.readyState < 2 || !video.videoWidth) return;
    setCanvasSize();
    if (gl && program) {
      try {
        gl.useProgram(program);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.uniform2f(uniforms.texel, 1 / video.videoWidth, 1 / video.videoHeight);
        gl.uniform1f(uniforms.sharpness, Number(controls.sharpness.value) / 100);
        gl.uniform1f(uniforms.saturation, Number(controls.saturation.value) / 100);
        gl.uniform1f(uniforms.contrast, Number(controls.contrast.value) / 100);
        gl.uniform1f(uniforms.brightness, Number(controls.brightness.value) / 100);
        gl.uniform1f(uniforms.original, state.original ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      } catch (error) {
        if (error.name !== "InvalidStateError") console.warn("Preview frame skipped", error);
      }
    } else if (fallbackContext) {
      const saturation = state.original ? 100 : controls.saturation.value;
      const contrast = state.original ? 100 : controls.contrast.value;
      const brightness = state.original ? 100 : 100 + Number(controls.brightness.value);
      fallbackContext.filter = `saturate(${saturation}%) contrast(${contrast}%) brightness(${brightness}%)`;
      fallbackContext.drawImage(video, 0, 0, canvas.width, canvas.height);
      fallbackContext.filter = "none";
    }
  }

  function renderLoop() {
    drawFrame();
    state.raf = requestAnimationFrame(renderLoop);
  }
  state.raf = requestAnimationFrame(renderLoop);

  function useFile(file) {
    if (!file) return;
    if (state.exporting) {
      notify("현재 작업을 마친 뒤 새 영상을 선택해 주세요.");
      return;
    }
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|m4v|ogv|avi|mkv)$/i.test(file.name)) {
      notify("영상 파일을 선택해 주세요.");
      return;
    }
    if (state.url) URL.revokeObjectURL(state.url);
    state.file = file;
    state.url = URL.createObjectURL(file);
    video.pause();
    video.src = state.url;
    video.load();
    $("#fileName").textContent = file.name;
    $("#fileMeta").textContent = formatBytes(file.size);
    $("#playButton").disabled = true;
    $("#muteButton").disabled = true;
    $("#seekBar").disabled = true;
    refreshExportAvailability();
    $("#compareButton").disabled = true;
    dropZone.classList.remove("has-video");
    emptyState.querySelector("h3").textContent = "영상을 불러오는 중입니다";
    emptyState.querySelector("p").textContent = "파일 크기와 기기 성능에 따라 잠시 걸릴 수 있습니다.";
    emptyState.querySelector(".upload-button").hidden = true;
  }

  video.addEventListener("loadedmetadata", () => {
    const fpsText = controls.fps.value === "source" ? "원본 프레임" : `${controls.fps.value} fps 출력`;
    $("#fileMeta").textContent = `${video.videoWidth} × ${video.videoHeight} · ${formatTime(video.duration)} · ${fpsText}`;
    $("#playButton").disabled = false;
    $("#muteButton").disabled = false;
    $("#seekBar").disabled = false;
    refreshExportAvailability();
    $("#compareButton").disabled = false;
    emptyState.querySelector("h3").textContent = "영상으로 시작해 보세요";
    emptyState.querySelector("p").innerHTML = "파일을 여기에 끌어다 놓거나<br />아래 버튼으로 선택하세요.";
    emptyState.querySelector(".upload-button").hidden = false;
    dropZone.classList.add("has-video");
    $("#stageOverlay").hidden = false;
    $("#seekBar").value = "0";
    updateOutputSummary();
    drawFrame();
  });

  video.addEventListener("error", () => {
    if (!state.file) return;
    dropZone.classList.remove("has-video");
    emptyState.querySelector("h3").textContent = "이 영상을 재생할 수 없습니다";
    emptyState.querySelector("p").textContent = "브라우저가 지원하는 MP4, MOV 또는 WebM 파일인지 확인해 주세요.";
    emptyState.querySelector(".upload-button").hidden = false;
    notify("지원하지 않는 코덱이거나 손상된 영상입니다.", 4500);
  });

  video.addEventListener("timeupdate", () => {
    $("#timecode").innerHTML = `${formatTime(video.currentTime)} <i>/</i> ${formatTime(video.duration)}`;
    if (!$("#seekBar").matches(":active") && video.duration) $("#seekBar").value = String(Math.round((video.currentTime / video.duration) * 1000));
  });
  video.addEventListener("play", () => { $("#playIcon").textContent = "Ⅱ"; $("#playButton").setAttribute("aria-label", "일시 정지"); });
  video.addEventListener("pause", () => { $("#playIcon").textContent = "▶"; $("#playButton").setAttribute("aria-label", "재생"); });
  video.addEventListener("seeked", drawFrame);

  $("#chooseButton").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (event) => {
    useFile(event.target.files?.[0]);
    event.target.value = "";
  });
  $("#playButton").addEventListener("click", () => {
    if (video.paused) video.play().catch(() => notify("이 영상은 재생할 수 없습니다."));
    else video.pause();
  });
  $("#muteButton").addEventListener("click", () => {
    video.muted = !video.muted;
    $("#muteButton").classList.toggle("muted", video.muted);
    $("#muteButton").setAttribute("aria-label", video.muted ? "음소거 해제" : "음소거");
  });
  $("#seekBar").addEventListener("input", (event) => {
    if (video.duration) video.currentTime = (Number(event.target.value) / 1000) * video.duration;
  });
  $("#compareButton").addEventListener("click", (event) => {
    state.original = !state.original;
    event.currentTarget.textContent = state.original ? "보정 결과" : "원본 보기";
    event.currentTarget.setAttribute("aria-pressed", String(state.original));
    $("#overlayLabel").textContent = state.original ? "원본" : "보정 미리보기";
    drawFrame();
  });

  document.querySelectorAll(".styled-range").forEach((control) => control.addEventListener("input", syncControls));
  controls.fps.addEventListener("change", () => {
    if (state.file) $("#fileMeta").textContent = `${video.videoWidth} × ${video.videoHeight} · ${formatTime(video.duration)} · ${controls.fps.value === "source" ? "원본 프레임" : `${controls.fps.value} fps 출력`}`;
    syncControls();
  });
  [controls.preset, controls.format, controls.codec, controls.bitrate].forEach((control) => control.addEventListener("change", syncControls));
  $("#resolutionOptions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-resolution]");
    if (!button) return;
    state.resolution = button.dataset.resolution;
    document.querySelectorAll("[data-resolution]").forEach((item) => item.classList.toggle("selected", item === button));
    syncControls();
  });
  $("#resetButton").addEventListener("click", () => {
    controls.sharpness.value = "55";
    controls.saturation.value = "118";
    controls.contrast.value = "106";
    controls.brightness.value = "1";
    controls.fps.value = "60";
    controls.preset.value = "medium";
    controls.format.value = "mp4";
    controls.codec.value = "auto";
    controls.bitrate.value = "";
    state.resolution = "8k";
    document.querySelectorAll("[data-resolution]").forEach((item) => item.classList.toggle("selected", item.dataset.resolution === "8k"));
    state.original = false;
    $("#compareButton").textContent = "원본 보기";
    $("#compareButton").setAttribute("aria-pressed", "false");
    $("#overlayLabel").textContent = "보정 미리보기";
    syncControls();
  });

  ["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  }));
  dropZone.addEventListener("drop", (event) => useFile(event.dataTransfer.files?.[0]));

  function setExportProgress(progress, stage) {
    const percentage = Math.max(0, Math.min(100, Math.round(progress)));
    $("#progressFill").style.width = `${percentage}%`;
    $("#progressPercent").textContent = `${percentage}%`;
    $("#progressLabel").textContent = stage || "브라우저에서 영상 처리 중";
  }

  async function toBlobURL(url, mimeType) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("영상 처리 엔진 파일을 불러오지 못했습니다.");
    return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: mimeType }));
  }

  async function ensureEngine() {
    if (state.ffmpeg && state.engineReady) return state.ffmpeg;
    if (!window.FFmpegWASM?.FFmpeg) throw new Error("FFmpeg WASM 라이브러리를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.");
    $("#engineStatusText").textContent = "영상 처리 엔진 불러오는 중 · 약 31 MB";
    setExportProgress(0, "브라우저 영상 엔진 불러오는 중");
    const ffmpeg = new window.FFmpegWASM.FFmpeg();
    let classWorkerURL = "";
    let coreURL = "";
    let wasmURL = "";
    ffmpeg.on("log", ({ message }) => {
      state.logLines.push(message);
      if (state.logLines.length > 120) state.logLines.splice(0, state.logLines.length - 120);
      const line = message.match(/frame=\s*(\d+)/);
      if (line && state.exporting) {
        const frames = Number(line[1]);
        if (frames > 0 && Number.isFinite(video.duration)) {
          const percent = Math.min(94, (frames / Math.max(1, video.duration * 60)) * 94);
          setExportProgress(percent, "FFmpeg WASM 영상 처리 중");
        }
      }
    });
    ffmpeg.on("progress", ({ progress }) => {
      if (state.exporting && Number.isFinite(progress)) setExportProgress(Math.min(94, 6 + progress * 88), "FFmpeg WASM 영상 처리 중");
    });

    const ffmpegBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd";
    const coreBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
    state.ffmpeg = ffmpeg;
    try {
      classWorkerURL = await toBlobURL(`${ffmpegBase}/814.ffmpeg.js`, "text/javascript");
      coreURL = `${coreBase}/ffmpeg-core.js`;
      wasmURL = await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm");
      await ffmpeg.load({ classWorkerURL, coreURL, wasmURL });
    } catch (error) {
      ffmpeg.terminate();
      state.ffmpeg = null;
      if (classWorkerURL) URL.revokeObjectURL(classWorkerURL);
      if (wasmURL) URL.revokeObjectURL(wasmURL);
      throw error;
    }
    URL.revokeObjectURL(classWorkerURL);
    URL.revokeObjectURL(wasmURL);
    state.ffmpeg = ffmpeg;

    const probe = async (target) => (await ffmpeg.exec(["-hide_banner", "-h", target])) === 0;
    state.capabilities = {
      minterpolate: await probe("filter=minterpolate"),
      cas: await probe("filter=cas"),
      h264: await probe("encoder=libx264"),
      hevc: await probe("encoder=libx265"),
    };
    if (!state.capabilities.h264 && !state.capabilities.hevc) throw new Error("이 브라우저 엔진에서 사용 가능한 H.264/HEVC 인코더가 없습니다.");
    state.ffmpeg = ffmpeg;
    state.engineReady = true;
    $("#engineStatusText").textContent = "FFmpeg WASM · 영상은 기기 내 처리";
    $("#engineStatus").classList.add("connected");
    const hevcOption = controls.codec.querySelector('option[value="hevc"]');
    hevcOption.disabled = !state.capabilities.hevc;
    if (!state.capabilities.h264) controls.codec.querySelector('option[value="h264"]').disabled = true;
    return ffmpeg;
  }

  function buildFilterChain(capabilities) {
    const filters = ["setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"];
    if (controls.fps.value !== "source" && capabilities.minterpolate) {
      const search = controls.preset.value === "fast" ? 16 : controls.preset.value === "ultra" ? 64 : 32;
      filters.push(`minterpolate=fps=${controls.fps.value}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:search_param=${search}:vsbmc=1`);
    }
    const { width, height } = getOutputSize();
    if ((width !== video.videoWidth || height !== video.videoHeight) && state.resolution !== "original") {
      filters.push(`scale=${width}:${height}:flags=lanczos+accurate_rnd`);
    }
    if (controls.sharpness.value !== "0" && capabilities.cas) filters.push(`cas=${(Number(controls.sharpness.value) / 100).toFixed(2)}`);
    filters.push(`eq=contrast=${(Number(controls.contrast.value) / 100).toFixed(2)}:brightness=${(Number(controls.brightness.value) / 100).toFixed(2)}:saturation=${(Number(controls.saturation.value) / 100).toFixed(2)}`);
    return filters.join(",");
  }

  async function executeTranscode(ffmpeg, inputName, outputName, encoder, filters, useAac) {
    const args = ["-y", "-hide_banner", "-i", inputName, "-map", "0:v:0", "-map", "0:a?", "-vf", filters, "-c:v", encoder];
    if (controls.bitrate.value) {
      const bitrate = controls.bitrate.value;
      const rate = Number.parseInt(bitrate, 10);
      args.push("-b:v", bitrate, "-maxrate", `${Math.round(rate * 1.5)}M`, "-bufsize", `${rate * 2}M`);
    } else {
      args.push("-crf", encoder === "libx265" ? "20" : "18");
    }
    const preset = controls.preset.value === "fast" ? "ultrafast" : controls.preset.value === "ultra" ? "slow" : "medium";
    args.push("-preset", preset, "-pix_fmt", "yuv420p");
    if (encoder === "libx265" && ["mp4", "mov"].includes(controls.format.value)) args.push("-tag:v", "hvc1");
    if (["mp4", "mov"].includes(controls.format.value)) args.push("-movflags", "+faststart");
    args.push("-c:a", useAac ? "aac" : "copy");
    if (useAac) args.push("-b:a", "256k");
    args.push(outputName);
    return ffmpeg.exec(args);
  }

  async function startExport() {
    if (!state.file || state.exporting) return;
    if (state.file.size >= 1.9 * 1024 ** 3) {
      notify("정적 브라우저 엔진은 최대 2 GB까지 지원합니다. 더 작은 영상으로 시도해 주세요.", 5000);
      return;
    }
    state.exporting = true;
    state.stopped = false;
    $("#exportButton").hidden = true;
    $("#progressWrap").hidden = false;
    $("#playButton").disabled = true;
    $("#seekBar").disabled = true;
    refreshExportAvailability();
    let inputName = "";
    let outputName = "";
    try {
      const ffmpeg = await ensureEngine();
      const capabilities = state.capabilities;
      if (!capabilities.minterpolate && controls.fps.value !== "source") throw new Error("이 WASM 빌드에 모션 보간 필터가 없습니다. 정적 방식으로는 프레임 보간을 실행할 수 없습니다.");
      if (Number(controls.sharpness.value) > 0 && !capabilities.cas) throw new Error("현재 FFmpeg WASM 빌드에 CAS 선명도 필터가 없습니다.");

      let encoder = controls.codec.value === "hevc" ? "libx265" : "libx264";
      if (controls.codec.value === "auto") encoder = capabilities.hevc && state.resolution === "8k" ? "libx265" : "libx264";
      if (encoder === "libx265" && !capabilities.hevc) throw new Error("현재 브라우저용 FFmpeg 빌드에는 HEVC 인코더가 없습니다. H.264를 선택해 주세요.");
      if (encoder === "libx264" && !capabilities.h264) throw new Error("현재 브라우저용 FFmpeg 빌드에는 H.264 인코더가 없습니다.");

      const extension = state.file.name.includes(".") ? state.file.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") : "mp4";
      inputName = `source_${Date.now()}.${extension || "mp4"}`;
      outputName = `YBK_Video_Enhancer_${state.resolution}.${controls.format.value}`;
      setExportProgress(1, "브라우저에서 영상 읽는 중");
      const data = new Uint8Array(await state.file.arrayBuffer());
      await ffmpeg.writeFile(inputName, data);
      setExportProgress(3, "Lanczos · CAS · 모션 보간 적용 중");
      const filters = buildFilterChain(capabilities);
      state.logLines = [];
      let exitCode = await executeTranscode(ffmpeg, inputName, outputName, encoder, filters, false);
      if (exitCode !== 0) {
        try { await ffmpeg.deleteFile(outputName); } catch { /* Output may not exist after failed encoding. */ }
        setExportProgress(88, "오디오 호환성 조정 중");
        exitCode = await executeTranscode(ffmpeg, inputName, outputName, encoder, filters, true);
      }
      if (state.stopped) return;
      if (exitCode !== 0) {
        const reason = state.logLines.slice(-8).join(" ").replace(/\s+/g, " ").slice(-400);
        throw new Error(reason || "영상 인코딩에 실패했습니다. 다른 출력 형식이나 코덱을 선택해 주세요.");
      }

      setExportProgress(96, "결과 파일 준비 중");
      const outputData = await ffmpeg.readFile(outputName);
      const mimeType = controls.format.value === "mp4" ? "video/mp4" : controls.format.value === "mov" ? "video/quicktime" : "video/x-matroska";
      const objectUrl = URL.createObjectURL(new Blob([outputData.buffer], { type: mimeType }));
      const baseName = (state.file.name.replace(/\.[^.]+$/, "") || "video").replace(/[\\/:*?"<>|]/g, "-");
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${baseName}_YBK_Video_Enhancer_${state.resolution}.${controls.format.value}`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setExportProgress(100, "완료 · 다운로드 시작");
      notify("YBK Video Enhancer 결과를 다운로드했습니다.", 4500);
    } catch (error) {
      if (!state.engineReady && state.ffmpeg) {
        state.ffmpeg.terminate();
        state.ffmpeg = null;
      }
      if (!state.engineReady) $("#engineStatusText").textContent = "브라우저 엔진 로드 실패";
      const detail = error?.message || (typeof error === "string" ? error : "");
      if (!state.stopped) notify(detail || "브라우저 영상 처리에 실패했습니다.", 6000);
    } finally {
      if (state.ffmpeg && inputName) {
        try { await state.ffmpeg.deleteFile(inputName); } catch { /* Input may have been cleared when the engine was terminated. */ }
      }
      if (state.ffmpeg && outputName && !state.stopped) {
        try { await state.ffmpeg.deleteFile(outputName); } catch { /* Output may already have been read and removed. */ }
      }
      if (!state.stopped) {
        state.exporting = false;
        $("#progressWrap").hidden = true;
        $("#exportButton").hidden = false;
        $("#playButton").disabled = false;
        $("#seekBar").disabled = false;
        refreshExportAvailability();
      }
    }
  }

  $("#exportButton").addEventListener("click", startExport);
  $("#cancelExport").addEventListener("click", () => {
    if (!state.exporting) return;
    state.stopped = true;
    state.ffmpeg?.terminate();
    state.ffmpeg = null;
    state.engineReady = false;
    $("#engineStatusText").textContent = "엔진 종료됨 · 다음 작업 시 다시 로드";
    $("#engineStatus").classList.remove("connected");
    state.exporting = false;
    $("#progressWrap").hidden = true;
    $("#exportButton").hidden = false;
    $("#playButton").disabled = false;
    $("#seekBar").disabled = false;
    refreshExportAvailability();
    notify("영상 처리를 취소하고 메모리를 정리했습니다.");
  });
  window.addEventListener("beforeunload", () => {
    if (state.url) URL.revokeObjectURL(state.url);
    cancelAnimationFrame(state.raf);
  });

  syncControls();
})();