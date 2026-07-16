(function() {
  let gl = null;
  let program = null;
  let canvas = null;
  let vao = null;
  let positionBuffer = null;
  let isRunning = false;
  let contextLost = false;
  let animationFrameId = null;
  let startTime = performance.now();

  // Uniform locations cache
  let uniforms = {};

  // Reusable typed arrays for batch updates
  const positionBufferData = new Float32Array([
    -1.0, -1.0,
     1.0, -1.0,
    -1.0,  1.0,
     1.0,  1.0
  ]);
  const panelCenters = new Float32Array(30);
  const panelSizes = new Float32Array(30);
  const panelRadii = new Float32Array(15);

  // Debouncing panel DOM queries
  let lastPanelQueryTime = 0;
  let cachedPanels = [];

  // Cache last-uploaded theme so we only push color uniforms on change
  let lastThemeName = null;

  // FPS-based quality adaptation state.
  // Quality tiers combine blur kernel size with a render-resolution (DPR) cap.
  // Lower tiers render fewer fragments — the per-fragment blur loop dominates cost.
  const QUALITY_TIERS = [
    { blurHalfWidth: 2, dprCap: 2.0 }, // 0: high
    { blurHalfWidth: 2, dprCap: 1.5 }, // 1: medium
    { blurHalfWidth: 1, dprCap: 1.0 }  // 2: low
  ];
  let frameCount = 0;
  let lastFpsTime = performance.now();
  let fps = 60;
  let autoQualityScale = true;
  let qualityTier = 0;
  let lastTierChangeTime = 0;
  let manualQualityOverride = null; // null = auto, or a fixed tier index

  function activeTier() {
    return QUALITY_TIERS[manualQualityOverride !== null ? manualQualityOverride : qualityTier];
  }

  const vsSource = `#version 300 es
  in vec2 a_position;
  void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
  }`;

  const fsSource = `#version 300 es
  precision highp float;

  out vec4 fragColor;

  uniform vec2 u_resolution;
  uniform float u_time;

  uniform int u_num_panels;
  uniform vec2 u_panel_centers[15];
  uniform vec2 u_panel_sizes[15];
  uniform float u_panel_radii[15];

  // dynamic blur quality uniform
  uniform int u_blur_half_width;

  // Theme colors passed from JS
  uniform vec3 u_bg_color_1; // dark theme color
  uniform vec3 u_bg_color_2; // bright theme color
  uniform vec3 u_bg_color_3; // mid theme color

  float box(vec2 p, vec2 b, float r) {
      vec2 q = abs(p) - b + r;
      return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  // Highly optimized, subtle, self-flowing wave background (4 trig calls: ultra-fast)
  vec4 getBackgroundWithPositions(vec2 uv) {
      float t = u_time * 0.04; // Very slow, calm movement
      vec2 p = uv * 2.5;
      
      float w1 = sin(p.x + t) * 0.4;
      float w2 = cos(p.y - t) * 0.4;
      float val = sin(p.x + w2) * cos(p.y + w1) * 0.5 + 0.5;

      // Mix colors using original ratios
      vec3 col = mix(u_bg_color_1, u_bg_color_3, val * 0.5);
      col = mix(col, u_bg_color_2, val * 0.15);

      // Desaturate and darken to make it extremely subtle and premium
      float luminance = col.r * 0.2126 + col.g * 0.7152 + col.b * 0.0722;
      vec3 desaturated = mix(vec3(luminance), col, 0.35); // 35% saturation
      col = desaturated * 0.28; // 28% brightness

      return vec4(col, 1.0);
  }

  void main() {
      vec2 uv = gl_FragCoord.xy / u_resolution;

      // Cache background results for unblurred UV
      vec4 unblurred_color = getBackgroundWithPositions(uv);

      // SDF evaluation across panels
      float min_d = 999999.0;
      int matched_idx = -1;
      vec2 matched_center = vec2(0.0);
      vec2 matched_size = vec2(0.0);
      float matched_radius = 0.0;

      for (int i = 0; i < 15; i++) {
          if (i >= u_num_panels) break;
          vec2 center = u_panel_centers[i];
          vec2 size = u_panel_sizes[i];
          float radius = u_panel_radii[i];

          vec2 p = gl_FragCoord.xy - center;
          float d = box(p, size * 0.5, radius);
          if (d < min_d) {
              min_d = d;
              matched_idx = i;
              matched_center = center;
              matched_size = size;
              matched_radius = radius;
          }
      }

      // Border transition: 2px feather inside/outside
      float transition = smoothstep(2.0, -2.0, min_d);

      // Only compute full blur when actually inside a glass panel
      if (transition > 0.0) {
          vec2 p = gl_FragCoord.xy - matched_center;
          
          // Refraction
          float refraction_dist = matched_size.y * 0.25;
          float factor = sin(pow(clamp(-min_d / refraction_dist, 0.0, 1.0), 0.25) * 1.5707);
          
          // Refracted UV coordinates
          vec2 lens_uv = mix(vec2(0.5), uv, factor);

          // Blurring loop
          vec4 blurred_color = vec4(0.0);
          float total_weight = 0.0;
          
          // 3x3 loop (u_blur_half_width=1), 5x5 loop (u_blur_half_width=2)
          float blur_step_size = 4.0;
          vec2 tex_el = blur_step_size / u_resolution;
          
          for (int x = -2; x <= 2; x++) {
              for (int y = -2; y <= 2; y++) {
                   if (x >= -u_blur_half_width && x <= u_blur_half_width && 
                       y >= -u_blur_half_width && y <= u_blur_half_width) {
                       vec2 offset = vec2(float(x), float(y)) * tex_el;
                       blurred_color += getBackgroundWithPositions(lens_uv + offset);
                       total_weight += 1.0;
                   }
              }
          }
          blurred_color /= total_weight;

          // Thin 1.5px border outline
          float d_border_ext = box(p, matched_size * 0.5 + 1.5, matched_radius);
          float rb2 = clamp(-d_border_ext / 1.5, 0.0, 1.0) - clamp(-min_d / 1.5, 0.0, 1.0);

          // Highlight gradient (4px wide)
          float d_grad_ext = box(p, matched_size * 0.5 + 4.0, matched_radius);
          float d_grad_int = box(p, matched_size * 0.5 - 4.0, matched_radius);
          float rb3 = clamp(-d_grad_ext / 4.0, 0.0, 1.0) - clamp(-d_grad_int / 4.0, 0.0, 1.0);

          // Specular/directional light highlight
          float rel_y = p.y / (matched_size.y * 0.5);
          float highlight = 0.0;
          if (rel_y > 0.0) {
              highlight = clamp(rel_y * 0.05, 0.0, 0.05);
          } else {
              highlight = clamp(-rel_y * rb3 * 0.05, 0.0, 0.05);
          }

          // Apply glass properties
          blurred_color.rgb += vec3(rb2 * 0.08); // Subtle border
          blurred_color.rgb += vec3(highlight);  // Top reflection
          blurred_color.rgb = mix(blurred_color.rgb, vec3(1.0), 0.015); // Subtle frost

          // Mix with cached pure background outside
          fragColor = mix(unblurred_color, blurred_color, transition);
      } else {
          fragColor = unblurred_color;
      }
  }`;

  function compileShader(source, type) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function initShaders() {
    const vs = compileShader(vsSource, gl.VERTEX_SHADER);
    const fs = compileShader(fsSource, gl.FRAGMENT_SHADER);
    if (!vs || !fs) return false;

    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_position'); // Force attribute to index 0
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return false;
    }

    // Shaders are linked into the program now; the standalone objects can go.
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    gl.useProgram(program);

    // Cache uniform locations
    const uniformsToCache = [
      'u_resolution', 'u_time', 'u_num_panels',
      'u_bg_color_1', 'u_bg_color_2', 'u_bg_color_3',
      'u_blur_half_width'
    ];
    uniformsToCache.forEach(u => {
      uniforms[u] = gl.getUniformLocation(program, u);
    });

    uniforms.u_panel_centers = gl.getUniformLocation(program, 'u_panel_centers');
    uniforms.u_panel_sizes = gl.getUniformLocation(program, 'u_panel_sizes');
    uniforms.u_panel_radii = gl.getUniformLocation(program, 'u_panel_radii');

    return true;
  }

  // Theme Color Palettes
  const THEME_COLORS = {
    discord: {
      bg1: [0.0, 0.0, 0.0],
      bg2: [0.05, 0.15, 0.9],
      bg3: [0.0, 0.05, 0.5]
    },
    aurora: {
      bg1: [0.0, 0.0, 0.0],
      bg2: [0.05, 0.9, 0.4],
      bg3: [0.0, 0.4, 0.15]
    },
    fire: {
      bg1: [0.0, 0.0, 0.0],
      bg2: [0.9, 0.15, 0.05],
      bg3: [0.5, 0.05, 0.0]
    },
    ice: {
      bg1: [0.0, 0.0, 0.0],
      bg2: [0.1, 0.6, 0.9],
      bg3: [0.0, 0.2, 0.5]
    },
    dark: {
      bg1: [0.0, 0.0, 0.0],
      bg2: [0.35, 0.35, 0.40],
      bg3: [0.12, 0.12, 0.15]
    }
  };

  function getActiveTheme() {
    const list = document.body.classList;
    if (list.contains('theme-aurora')) return 'aurora';
    if (list.contains('theme-fire')) return 'fire';
    if (list.contains('theme-ice')) return 'ice';
    if (list.contains('theme-dark')) return 'dark';
    return 'discord';
  }

  function getActivePanels() {
    const panels = [];
    const selectors = '.sidebar, .chat-header, .composer, .thread-panel:not(#profile-panel), .members-panel, .saved-panel, .glass-panel';
    const els = document.querySelectorAll(selectors);

    els.forEach(el => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).display !== 'none' && !el.classList.contains('hidden')) {
        const rect = el.getBoundingClientRect();
        const computedStyle = window.getComputedStyle(el);
        const borderRadiusStr = computedStyle.borderRadius;
        let radius = 0.0;
        if (borderRadiusStr) {
          const val = parseFloat(borderRadiusStr);
          if (!isNaN(val)) radius = val;
        }
        panels.push({ rect, radius });
      }
    });

    return panels.slice(0, 15);
  }

  function getActivePanelsDebounced() {
    const now = Date.now();
    if (now - lastPanelQueryTime >= 100) { // Limit queries to 10Hz
      lastPanelQueryTime = now;
      cachedPanels = getActivePanels();
    }
    return cachedPanels;
  }

  function monitorFPS(now) {
    frameCount++;
    const delta = now - lastFpsTime;

    if (delta < 500) return;

    fps = (frameCount * 1000.0) / delta;
    frameCount = 0;
    lastFpsTime = now;

    if (!autoQualityScale || manualQualityOverride !== null) return;

    // Hysteresis: only step quality after a short cooldown so it doesn't
    // oscillate on the boundary. Drop quality fast when struggling, recover slowly.
    if (now - lastTierChangeTime < 1500) return;

    if (fps < 45 && qualityTier < QUALITY_TIERS.length - 1) {
      qualityTier++;
      lastTierChangeTime = now;
    } else if (fps > 58 && qualityTier > 0) {
      qualityTier--;
      lastTierChangeTime = now;
    }
  }

  function render() {
    if (!isRunning || contextLost) return;

    const now = performance.now();
    monitorFPS(now);

    const tier = activeTier();

    // Cap the device-pixel-ratio by the active quality tier. The canvas is
    // CSS-stretched to 100vw/100vh, so a lower internal resolution costs far
    // fewer fragments while the browser scales the result back up.
    const dpr = Math.min(window.devicePixelRatio || 1, tier.dprCap);
    const width = window.innerWidth;
    const height = window.innerHeight;

    const targetWidth = Math.floor(width * dpr);
    const targetHeight = Math.floor(height * dpr);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    gl.clear(gl.COLOR_BUFFER_BIT);

    // Resolution and time uniforms
    gl.uniform2f(uniforms.u_resolution, canvas.width, canvas.height);

    const time = (now - startTime) / 1000.0;
    gl.uniform1f(uniforms.u_time, time);
    gl.uniform1i(uniforms.u_blur_half_width, tier.blurHalfWidth);

    // Theme color uniforms — only re-upload when the active theme changes.
    const themeName = getActiveTheme();
    if (themeName !== lastThemeName) {
      lastThemeName = themeName;
      const colors = THEME_COLORS[themeName] || THEME_COLORS.discord;
      gl.uniform3fv(uniforms.u_bg_color_1, colors.bg1);
      gl.uniform3fv(uniforms.u_bg_color_2, colors.bg2);
      gl.uniform3fv(uniforms.u_bg_color_3, colors.bg3);
    }

    // Debounced Panel boundary tracking
    const panels = getActivePanelsDebounced();
    gl.uniform1i(uniforms.u_num_panels, panels.length);

    if (panels.length > 0) {
      // No need to clear the tail: the shader loop breaks at u_num_panels,
      // so indices beyond the active count are never read.
      for (let i = 0; i < panels.length; i++) {
        const p = panels[i];
        panelCenters[i * 2] = (p.rect.left + p.rect.width / 2.0) * dpr;
        panelCenters[i * 2 + 1] = (height - (p.rect.top + p.rect.height / 2.0)) * dpr;

        panelSizes[i * 2] = p.rect.width * dpr;
        panelSizes[i * 2 + 1] = p.rect.height * dpr;

        panelRadii[i] = p.radius * dpr;
      }

      gl.uniform2fv(uniforms.u_panel_centers, panelCenters);
      gl.uniform2fv(uniforms.u_panel_sizes, panelSizes);
      gl.uniform1fv(uniforms.u_panel_radii, panelRadii);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    animationFrameId = requestAnimationFrame(render);
  }

  // Build all GPU-side state. Re-runnable after a context-restore event.
  function initGLResources() {
    if (!initShaders()) return false;

    // Vertex Array Object captures the buffer + attribute layout once, so the
    // render loop only needs drawArrays — no per-frame bind/vertexAttribPointer.
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positionBufferData, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0); // a_position is bound to index 0
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(program);

    // Force a theme re-upload on next frame.
    lastThemeName = null;
    return true;
  }

  window.initGlassEngine = function() {
    canvas = document.getElementById('glass-canvas');
    if (!canvas) return;

    gl = canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      powerPreference: 'high-performance'
    });

    if (!gl) {
      console.warn('WebGL 2 context not available, disabled.');
      return;
    }

    // Recover gracefully from GPU context loss (driver resets, laptop GPU
    // switches, Electron window sleep) instead of silently freezing.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      contextLost = true;
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
      contextLost = false;
      uniforms = {};
      if (initGLResources() && isRunning) {
        startTime = performance.now();
        lastFpsTime = startTime;
        frameCount = 0;
        render();
      }
    }, false);

    // Stop burning frames while the window/tab is hidden; resume on return.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
      } else if (isRunning && !contextLost && animationFrameId === null) {
        lastFpsTime = performance.now();
        frameCount = 0;
        render();
      }
    });

    if (!initGLResources()) return;

    // Signal WebGL loading is active to override stylesheets
    document.body.classList.add('glass-engine-active');

    // Run performance mode initialization
    const savedLowPc = localStorage.getItem('haven_lowpc') === 'true';
    window.glassEngine.setPerformanceMode(savedLowPc);
  };

  // Expose WebGL API
  window.glassEngine = {
    setPerformanceMode: function(lowPc) {
      if (lowPc) {
        manualQualityOverride = 1; // force 3x3 grid
        currentBlurHalfWidth = 1;
        autoQualityScale = false;
      } else {
        manualQualityOverride = null;
        autoQualityScale = true;
        currentBlurHalfWidth = 2; // restore 5x5 grid
      }

      // Keep animation frame loop alive in all states
      if (!isRunning) {
        isRunning = true;
        startTime = Date.now();
        lastFpsTime = Date.now();
        frameCount = 0;
        render();
      }
    }
  };
})();
