#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform sampler2D u_detailMap;
uniform highp sampler2DArray u_detailAtlas;
uniform sampler2D u_nativeMap;
uniform highp sampler2DArray u_nativeAtlas;
uniform sampler2D u_patch;
uniform sampler2D u_fontaineSea;
uniform highp sampler3D u_cloudField;
uniform vec4 u_fontaineSeaRect;
uniform sampler2D u_moonStencil;
uniform vec2 u_center;
uniform float u_radius;
uniform vec3 u_right;
uniform vec3 u_up;
uniform vec3 u_front;
uniform vec3 u_sea;
uniform vec2 u_span;
uniform float u_zoom;
uniform float u_flatten;
uniform vec2 u_chartScale;
uniform int u_projection;
uniform bool u_oceanRelief;
uniform bool u_naturalMoon;
uniform bool u_cleanFontaine;
uniform vec2 u_detailSize;
uniform vec2 u_nativeSize;
uniform vec4 u_patchRect;
uniform vec3 u_occluder;
uniform float u_orbitLook;
uniform vec2 u_cloudRotation;
uniform mat3 u_lunarPreviewBasis;
uniform bool u_hasLunarPreview;
uniform float u_lunarMapBlend;
out vec4 pixel;

const float PI = 3.14159265359;
// A low sun leaves a crescent of direct light with a subdued night side.
const vec3 ORBIT_SUN = vec3(-.961, -.08, -.264);
const vec2 AURA_LIGHT_DIRECTION = vec2(-.991, -.133);
const vec3 AURA_HIGHLIGHT = vec3(.86, .98, 1.);

vec3 neutralColor(vec3 color) {
  return vec3(dot(color, vec3(.2126, .7152, .0722)));
}

vec3 readAtlas(vec2 uv, vec2 dx, vec2 dy) {
  // 按当前像素覆盖的纹素范围，从已加载瓦片的 mip 层采样。
  vec4 native = vec4(0.);
  if (u_nativeSize.x > 0.) {
    vec2 p = clamp(uv * u_nativeSize, vec2(.5), u_nativeSize - .5);
    ivec2 tile = ivec2(floor(p / 512.));
    float layer = texelFetch(u_nativeMap, tile, 0).r * 255. - 1.;
    if (layer >= -.01) {
      vec2 local = clamp(p - vec2(tile) * 512., .5, 511.5) / 512.;
      native = textureGrad(u_nativeAtlas, vec3(local, round(layer)),
        dx * (u_nativeSize / 512.), dy * (u_nativeSize / 512.));
      if (native.a >= .999) return native.rgb;
    }
  }
  vec3 base = textureGrad(u_atlas, clamp(uv, 0., 1.), dx, dy).rgb;
  if (u_detailSize.x > 0.) {
    vec2 pixelPos = clamp(uv * u_detailSize, vec2(.5), u_detailSize - .5);
    ivec2 tile = ivec2(floor(pixelPos / 512.));
    float layer = texelFetch(u_detailMap, tile, 0).r * 255. - 1.;
    if (layer >= -.01) {
      vec2 local = clamp(pixelPos - vec2(tile) * 512., .5, 511.5) / 512.;
      vec4 detail = textureGrad(u_detailAtlas, vec3(local, round(layer)),
        dx * (u_detailSize / 512.), dy * (u_detailSize / 512.));
      base = mix(base, detail.rgb, detail.a);
    }
  }
  return mix(base, native.rgb, native.a);
}

vec3 applyGroundPatch(vec3 base, vec2 uv, vec2 dx, vec2 dy) {
  if (u_patchRect.z <= 0.) return base;
  vec2 local = (uv - u_patchRect.xy) / u_patchRect.zw;
  if (any(lessThan(local, vec2(0.))) || any(greaterThan(local, vec2(1.)))) return base;
  vec4 artwork = textureGrad(u_patch, local, dx / u_patchRect.zw, dy / u_patchRect.zw);
  return mix(base, artwork.rgb, artwork.a);
}

vec3 lunarChart(vec2 uv, vec2 dx, vec2 dy) {
  return applyGroundPatch(readAtlas(uv, dx, dy), uv, dx, dy);
}

float lunarRadius(float angle) {
  return angle - .053 * smoothstep(.80, 1., angle);
}

vec2 lunarUV(vec3 n, float side) {
  vec4 disk = side > 0. ? vec4(.708, .510, .274, .466) : vec4(.264, .510, .259, .466);
  float distance = length(n.xy);
  float angle = min(1., acos(clamp(side * n.z, -1., 1.)) * (2. / PI));
  float scale = distance < .000001 ? 0. : lunarRadius(angle) / distance;
  return disk.xy + vec2(side * n.x, -n.y) * scale * disk.zw;
}

vec3 lunarTerrain(vec2 nearUV, vec2 farUV, float depth) {
  vec2 nearDx = dFdx(nearUV), nearDy = dFdy(nearUV);
  vec2 farDx = dFdx(farUV), farDy = dFdy(farUV);
  float nearWeight = smoothstep(-.23, .23, depth);
  if (nearWeight <= 0.) return lunarChart(farUV, farDx, farDy);
  if (nearWeight >= 1.) return lunarChart(nearUV, nearDx, nearDy);
  return mix(lunarChart(farUV, farDx, farDy), lunarChart(nearUV, nearDx, nearDy), nearWeight);
}

vec2 chartGradient(vec3 n, vec3 change) {
  float longitude = (n.z * change.x - n.x * change.z) / max(.00001, dot(n.xz, n.xz));
  float latitude = change.y / max(.001, sqrt(max(0., 1. - n.y * n.y)));
  return vec2(longitude, -latitude) / u_span;
}

vec3 applyFontaineSea(vec3 terrain, vec2 uv, vec2 dx, vec2 dy) {
  // 专用海面贴图：rect 为归一化 (left, top, w, h)，纹理未就绪时 z=0。
  if (u_fontaineSeaRect.z <= 0.) return terrain;
  vec2 local = (uv - u_fontaineSeaRect.xy) / u_fontaineSeaRect.zw;
  if (any(lessThan(local, vec2(0.))) || any(greaterThan(local, vec2(1.)))) return terrain;
  // 预乘 RGBA（JS 上传时 UNPACK_PREMULTIPLY_ALPHA_WEBGL=true）。
  vec4 seaPatch = textureGrad(u_fontaineSea, local, dx / u_fontaineSeaRect.zw, dy / u_fontaineSeaRect.zw);
  return terrain * (1. - seaPatch.a) + seaPatch.rgb;
}

vec3 oceanRelief(vec3 n) {
  // Continuous across the antimeridian and at the poles.
  float ridge = sin(dot(n, vec3(4., 7., 2.)) + 1.9 * sin(dot(n, vec3(8., -3., 6.))));
  float bend = sin(dot(n, vec3(8., 12., -10.)) - ridge * 1.8);
  float depth = sin(dot(n, vec3(-14., 13., 14.)) + ridge * 1.7 + bend * 1.25);
  float shelf = smoothstep(-.55, .70, ridge * .65 + bend * .33);
  float bands = sin(depth * 12. + bend * 2.5 + ridge * 2.);
  float contours = smoothstep(.87, 1., bands) * (.4 + .6 * shelf);
  float currents = pow(1. - abs(bend), 6.) * (.4 + shelf * .6);
  return vec3(.020, .059, .065) * shelf
    + vec3(.014, .045, .051) * currents
    + vec3(.013, .035, .037) * contours;
}

vec3 lunarMineral(vec3 terrain) {
  float luma = dot(terrain, vec3(.2126, .7152, .0722));
  return mix(terrain, mix(vec3(.072, .176, .226), vec3(.76, .91, .87), pow(luma, .72)), .68);
}

float lunarDot(vec2 cell, vec2 footprint) {
  float edge = clamp(length(footprint) * .55, .025, .18);
  return 1. - smoothstep(.17 - edge, .17 + edge, length(fract(cell) - .5));
}

vec3 lunarHazard(vec3 color, vec2 nearUV, vec2 farUV, bool nearSide) {
  vec2 uv = nearSide ? nearUV : farUV;
  float level = log2(max(1., u_zoom));
  vec2 cells = vec2(190., 190. * 9. / 17.) * exp2(floor(level));
  vec2 nearWidth = fwidth(nearUV * cells);
  vec2 farWidth = fwidth(farUV * cells);
  ivec2 size = textureSize(u_moonStencil, 0);
  ivec2 sourcePixel = clamp(ivec2(uv * vec2(size)), ivec2(0), size - 1);
  if (texelFetch(u_moonStencil, sourcePixel, 0).g >= .5) return color;
  vec2 footprint = nearSide ? nearWidth : farWidth;
  vec2 cell = uv * cells;
  // Refine the map-space lattice as the camera closes in, keeping the art readable.
  float dotMask = mix(lunarDot(cell, footprint), lunarDot(cell * 2., footprint * 2.),
    smoothstep(.38, .96, fract(level)));
  vec3 stencil = textureLod(u_moonStencil, uv, 0.).rgb;
  vec3 blue = mix(vec3(.13, .44, .93), vec3(.24, .65, .99), dotMask);
  color = mix(color, blue, stencil.r * (.14 + dotMask * .67));
  return mix(color, vec3(.385, .794, .76), stencil.b * .64);
}

float cloudDensity(vec2 p) {
  // Sample above the surface so the clouds have their own curvature and drift.
  vec2 q = p / 1.018;
  vec3 normal = u_right * q.x + u_up * q.y + u_front * sqrt(max(0., 1. - dot(q, q)));
  vec2 rotated = mat2(u_cloudRotation.x, -u_cloudRotation.y,
    u_cloudRotation.y, u_cloudRotation.x) * normal.xz;
  normal = vec3(rotated.x, normal.y, rotated.y);
  vec3 flow = normal * vec3(.235, .345, .235);
  flow += .028 * sin(normal.yzx * vec3(9., 10., 12.) + vec3(1., 2., 4.));
  float banks = texture(u_cloudField, flow).r;
  float detail = texture(u_cloudField, flow * 2.78 + vec3(.42, .31, .12)).r;
  float wisps = texture(u_cloudField, flow * 6.8 + vec3(.17, .23, .34)).r;
  return smoothstep(.48, .76, banks * .51 + detail * .33 + wisps * .16);
}

vec3 orbitalSurface(vec3 terrain, vec2 p, float z, float limbLight, float auraFocus, bool teyvat) {
  float incidence = dot(vec3(p, z), ORBIT_SUN);
  float illumination = smoothstep(-.23, .66, incidence);
  float luma = dot(terrain, vec3(.2126, .7152, .0722));
  vec3 muted = mix(terrain, vec3(luma), .42);
  vec3 night = muted * vec3(.16, .23, .33) + vec3(.012, .019, .033);
  vec3 day = muted * vec3(.73, 1.04, 1.34) + vec3(.021, .071, .133);
  float sunward = smoothstep(.42, .97, incidence);
  day += max(vec3(0.), 1. - day) * vec3(.13, .19, .24) * sunward;
  vec3 surface = mix(night, day, illumination);
  if (teyvat) {
    vec3 clouds = mix(vec3(.11, .22, .37), vec3(.77, .91, 1.), illumination);
    surface = mix(surface, clouds, cloudDensity(p) * mix(.14, .72, illumination));
  }

  // Grazing rays traverse more air. The broad haze transitions into a
  // narrower bright limb on the sunward side.
  float grazing = 1. - z;
  float haze = pow(grazing, 2.15) * mix(.10, .78, illumination);
  if (teyvat) haze *= .82;
  surface = mix(surface, mix(vec3(.034, .077, .174), vec3(.26, .72, .97), illumination), haze);
  float limb = exp(-z * 7.5) * mix(.10, .91, limbLight);
  surface = mix(surface, mix(vec3(.064, .14, .30), vec3(.73, .95, 1.), limbLight), limb);
  // The narrow highlight sits on the grazing rim, with softer light reaching
  // into the clouds and terrain beneath it.
  float rim = .49 * exp(-z * 13.);
  float scatter = .42 * (1. - smoothstep(.06, .48, z));
  surface = mix(surface, AURA_HIGHLIGHT, auraFocus * (rim + scatter));
  if (teyvat) {
    // A concentrated key light brightens the rim facing the source. Its
    // angular falloff keeps the rest of the crescent from lifting with it.
    float keyArc = auraFocus * auraFocus * auraFocus;
    float keyDepth = .64 * exp(-z * 6.5) + .22 * (1. - smoothstep(.05, .39, z));
    surface = mix(surface, vec3(.97, .99, 1.), keyArc * keyArc * keyDepth);
  }
  return mix(neutralColor(surface), surface, smoothstep(.02, .50, incidence));
}

vec3 lunarSideLight(vec3 terrain, vec2 p, float z) {
  float incidence = dot(vec3(p, z), ORBIT_SUN);
  float light = smoothstep(-.34, .73, incidence);
  vec3 shaded = terrain * mix(vec3(.57, .64, .74), vec3(1.08, 1.12, 1.16), light);
  float reflectedLight = .14 * pow(1. - z, 2.) * smoothstep(.13, .94, incidence);
  return mix(shaded, vec3(.73, .84, .96), reflectedLight);
}

vec3 moonPreviewTone(vec3 terrain, vec2 p, float z) {
  vec3 litMoon = lunarSideLight(lunarMineral(terrain), p, z);
  float luma = dot(litMoon, vec3(.2126, .7152, .0722));
  return mix(litMoon, vec3(luma), .44) * .78;
}

vec3 orbitalMoonSurface(vec3 n, vec2 p, float z, float limbLight, float auraFocus) {
  vec3 terrain = lunarTerrain(lunarUV(n, 1.), lunarUV(n, -1.), n.z);
  // Turn the chart into matte rock, retaining the cooler tones over the lunar sea.
  float luma = dot(terrain, vec3(.2126, .7152, .0722));
  vec3 rock = mix(vec3(.15, .16, .18), vec3(.51, .53, .57), sqrt(luma));
  float sea = smoothstep(.043, .22, min(terrain.g, terrain.b) - terrain.r) * smoothstep(.24, .58, luma);
  vec3 albedo = mix(rock, vec3(.22, .31, .37), .63 * sea);
  return neutralColor(orbitalSurface(albedo, p, z, limbLight, auraFocus, false));
}

vec4 premultiplied(vec3 color, float opacity) {
  return vec4(clamp(color, 0., 1.) * opacity, opacity);
}

vec4 withAtmosphere(vec3 color, float opacity, vec3 airColor, float airOpacity) {
  // The atmosphere lies behind the disk and shows through the antialiased edge.
  return premultiplied(color, opacity) + premultiplied(airColor, airOpacity * (1. - opacity));
}

void main() {
  if (u_occluder.z > 0. && distance(gl_FragCoord.xy, u_occluder.xy) < u_occluder.z) discard;
  vec2 p = (gl_FragCoord.xy - u_center) / u_radius;
  float r = length(p);
  float atmosphere = u_projection != 2 ? u_orbitLook : (u_hasLunarPreview ? 1. - u_lunarMapBlend : 0.);
  bool hasAtmosphere = atmosphere > 0.;
  if (r >= (hasAtmosphere ? 1.09 : 1.001)) discard;
  float moonAtmosphere = u_naturalMoon || u_projection == 2 ? atmosphere : 0.;
  float edge = mix(.003, max(.003, .8 / u_radius), moonAtmosphere);

  float limbLight = 0.;
  float auraFocus = 0.;
  float airOpacity = 0.;
  vec3 airColor = vec3(0.);
  if (hasAtmosphere) {
    vec2 rimDirection = p / max(r, .001);
    limbLight = smoothstep(-.17, .94, dot(rimDirection, ORBIT_SUN.xy));
    auraFocus = smoothstep(.52, .999, dot(rimDirection, AURA_LIGHT_DIRECTION));
    auraFocus *= auraFocus;
    // The disk is opaque inside the rim, so the outer glow cannot contribute there.
    if (r > 1. - edge) {
      float altitude = max(0., r - 1.);
      float falloff = moonAtmosphere > 0. ? 24. : 38.;
      float bloom = .67 * exp(-altitude * 103.) + .33 * exp(-altitude * falloff);
      float outerLight = bloom * .98 * limbLight;
      float halo = auraFocus * exp(-altitude * 82.);
      outerLight += (1. - outerLight) * halo * .43;
      airOpacity = outerLight * (1. - smoothstep(.035, .09, altitude)) * atmosphere;
      airColor = mix(vec3(.065, .18, .40), vec3(.44, .84, 1.), limbLight);
      airColor = mix(airColor, AURA_HIGHLIGHT, halo * .72);
      if (moonAtmosphere > 0.) airColor = neutralColor(airColor);
      else airOpacity *= .52;
    }
  }
  if (r >= 1.001) {
    pixel = premultiplied(airColor, airOpacity);
    return;
  }
  float opacity = 1. - smoothstep(1. - edge, 1.001, r);

  vec3 ice = vec3(.49, .79, .82);

  float z = sqrt(max(0., 1. - dot(p, p)));
  vec3 n = normalize(u_right * p.x + u_up * p.y + u_front * z);
  if (u_naturalMoon) {
    vec3 moon = orbitalMoonSurface(n, p, z, limbLight, auraFocus);
    pixel = withAtmosphere(moon, opacity, airColor, airOpacity);
    return;
  }
  if (u_projection == 2) {
    vec3 preview = vec3(0.);
    if (u_hasLunarPreview && u_lunarMapBlend < 1.) {
      vec3 previewNormal = normalize(u_lunarPreviewBasis * vec3(p, z));
      preview = orbitalMoonSurface(previewNormal, p, z, limbLight, auraFocus);
      if (u_lunarMapBlend == 0.) {
        pixel = withAtmosphere(preview, opacity, airColor, airOpacity);
        return;
      }
    }
    // 霜月路径不用等距柱状 uv 与 chart 梯度，直接走原有 lunarTerrain/lunarHazard。
    vec2 nearUV = lunarUV(n, 1.);
    vec2 farUV = lunarUV(n, -1.);
    vec3 terrain = lunarTerrain(nearUV, farUV, n.z);
    // Neutral limb shading keeps the original map colors outside the danger overlay.
    terrain *= 1. - .16 * pow(1. - z, 2.);
    vec3 chart = lunarHazard(terrain, nearUV, farUV, n.z >= 0.);
    vec3 shaded = mix(chart, lunarSideLight(chart, p, z), u_orbitLook);
    if (u_lunarMapBlend < 1.) {
      // Compact layouts have no orbit thumbnail. Start with neutral terrain.
      if (!u_hasLunarPreview) preview = moonPreviewTone(terrain, p, z);
      shaded = mix(preview, shaded, u_lunarMapBlend);
    }
    pixel = withAtmosphere(shaded, opacity, airColor, airOpacity);
    return;
  }
  float lon = atan(n.x, n.z);
  float lat = asin(clamp(n.y, -1., 1.));
  vec2 uv = vec2(lon / u_span.x + .5, .5 - lat / u_span.y);
  vec2 uvDx;
  vec2 uvDy;
  if (u_flatten == 1.) {
    // 完全平面：mix(x, y, 1.) 恒等于 y，直接取 chart，跳过球面 chartGradient。
    vec2 center = vec2(atan(u_front.x, u_front.z) / u_span.x + .5,
      .5 - asin(clamp(u_front.y, -1., 1.)) / u_span.y);
    uv = center + p * vec2(u_chartScale.x, -u_chartScale.y);
    uvDx = dFdx(uv);
    uvDy = dFdy(uv);
  } else {
    uvDx = chartGradient(n, dFdx(n));
    uvDy = chartGradient(n, dFdy(n));
    if (u_flatten > 0.) {
      vec2 center = vec2(atan(u_front.x, u_front.z) / u_span.x + .5,
        .5 - asin(clamp(u_front.y, -1., 1.)) / u_span.y);
      vec2 chart = center + p * vec2(u_chartScale.x, -u_chartScale.y);
      uv = mix(uv, chart, u_flatten);
      uvDx = mix(uvDx, dFdx(chart), u_flatten);
      uvDy = mix(uvDy, dFdy(chart), u_flatten);
    }
  }
  float margin = min(min(uv.x, 1. - uv.x), min(uv.y, 1. - uv.y));
  float coverage = smoothstep(0., .022, margin);
  // coverage==0 时 mix 恒等于 u_sea，可跳过纹理 fetch；羽化区间照常。
  vec3 terrain = u_sea;
  float footprint = 1. + .65 * u_orbitLook;
  if (coverage > 0.) terrain = mix(u_sea, readAtlas(uv, uvDx * footprint, uvDy * footprint), coverage);
  terrain = applyGroundPatch(terrain, uv, uvDx, uvDy);
  if (u_cleanFontaine) terrain = applyFontaineSea(terrain, uv, uvDx, uvDy);

  float land = smoothstep(.085, .25, length(terrain - u_sea));
  float brightness = dot(terrain, vec3(.2126, .7152, .0722));
  float sun = dot(vec3(p, z), normalize(vec3(-.63, .59, .64)));
  float daylight = smoothstep(-.52, .95, sun);
  vec3 sea = mix(vec3(.023, .059, .08), vec3(.094, .242, .276), daylight);
  sea += (terrain - u_sea) * .32;
  sea += .012 * sin(n.x * 17. + n.y * 21.) * sin(n.z * 14.);
  // The distant body uses clouds and open-water color. Contours only become
  // useful as the chart comes back into view.
  if (u_oceanRelief && u_orbitLook < 1.) {
    sea += oceanRelief(n) * (.72 + .43 * daylight) * (1. - u_orbitLook);
  }
  vec3 landColor;
  if (u_cleanFontaine) {
    // Teyvat：保留原图色相，仅按日照做轻柔中性明暗；卫星等其他世界保持原光照。
    landColor = terrain * mix(.72, 1., daylight);
  } else {
    landColor = mix(terrain, vec3(brightness * .94, brightness * 1.04, brightness * 1.04), .20);
    landColor *= (.51 + daylight * .52) * vec3(.94, 1.02, 1.08);
  }
  vec3 rgb = mix(sea, landColor, land * .94);

  float closeView = smoothstep(1.3, 4.4, u_zoom);
  if (u_orbitLook < 1.) {
    vec2 grid = vec2(lon, lat) * (12. / PI);
    vec2 gridDist = abs(fract(grid + .5) - .5);
    float lonDx = n.z * dFdx(n.x) - n.x * dFdx(n.z);
    float lonDy = n.z * dFdy(n.x) - n.x * dFdy(n.z);
    float longitudeWidth = (abs(lonDx) + abs(lonDy)) * (12. / PI) / max(.004, dot(n.xz, n.xz));
    vec2 gridWidth = clamp(vec2(longitudeWidth, fwidth(grid.y)) * .8, .001, .12);
    vec2 etched = 1. - smoothstep(gridWidth * .45, gridWidth * 1.3, gridDist);
    float graticule = max(etched.x, etched.y) * (.04 + daylight * .085) * smoothstep(.15, .6, z);
    graticule *= (1. - closeView * .92) * (1. - u_orbitLook);
    rgb = mix(rgb, ice, graticule * (1. - land * .65));
  }

  rgb = mix(rgb, vec3(.046, .102, .128), pow(1. - z, 2.6) * .43);
  // 近景淡回烘焙原图（含海面贴图），复用现有 closeView。
  if (u_cleanFontaine) {
    rgb = mix(rgb, terrain, closeView * coverage * smoothstep(.28, .82, z));
  }
  if (u_orbitLook > 0.) {
    vec3 orbitalAlbedo = rgb;
    // Outside the atlas, ease into open water so the edge of the mapped
    // rectangle remains invisible. Keep the variation fixed to the sphere.
    if (margin < 0.) {
      float offshore = smoothstep(0., .20, -margin);
      float water = texture(u_cloudField, n * .091 + vec3(.21, .63, .48)).r;
      vec3 openOcean = mix(vec3(.043, .279, .421), vec3(.092, .447, .574), water);
      orbitalAlbedo = mix(orbitalAlbedo, openOcean, offshore);
    }
    rgb = mix(rgb, orbitalSurface(orbitalAlbedo, p, z, limbLight, auraFocus, true), u_orbitLook);
  }
  pixel = withAtmosphere(rgb, opacity, airColor, airOpacity);
}
