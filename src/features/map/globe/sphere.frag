#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform sampler2D u_detailMap;
uniform highp sampler2DArray u_detailAtlas;
uniform sampler2D u_nativeMap;
uniform highp sampler2DArray u_nativeAtlas;
uniform sampler2D u_patch;
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
out vec4 pixel;

const float PI = 3.14159265359;

vec3 readAtlas(vec2 uv, vec2 dx, vec2 dy) {
  // 按当前像素覆盖的纹素范围，从已加载瓦片的 mip 层采样。
  if (u_nativeSize.x > 0.) {
    vec2 p = clamp(uv * u_nativeSize, vec2(.5), u_nativeSize - .5);
    ivec2 tile = ivec2(floor(p / 512.));
    float layer = texelFetch(u_nativeMap, tile, 0).r * 255. - 1.;
    if (layer >= -.01) {
      vec2 local = clamp(p - vec2(tile) * 512., .5, 511.5) / 512.;
      return textureGrad(u_nativeAtlas, vec3(local, round(layer)), dx * (u_nativeSize / 512.), dy * (u_nativeSize / 512.)).rgb;
    }
  }
  vec3 base = textureGrad(u_atlas, clamp(uv, 0., 1.), dx, dy).rgb;
  if (u_detailSize.x > 0.) {
    vec2 pixelPos = clamp(uv * u_detailSize, vec2(.5), u_detailSize - .5);
    ivec2 tile = ivec2(floor(pixelPos / 512.));
    float layer = texelFetch(u_detailMap, tile, 0).r * 255. - 1.;
    if (layer >= -.01) {
      vec2 local = clamp(pixelPos - vec2(tile) * 512., .5, 511.5) / 512.;
      return textureGrad(u_detailAtlas, vec3(local, round(layer)), dx * (u_detailSize / 512.), dy * (u_detailSize / 512.)).rgb;
    }
  }
  return base;
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

vec3 lunarTerrain(vec3 n) {
  vec2 nearUV = lunarUV(n, 1.);
  vec2 farUV = lunarUV(n, -1.);
  vec2 nearDx = dFdx(nearUV), nearDy = dFdy(nearUV);
  vec2 farDx = dFdx(farUV), farDy = dFdy(farUV);
  float nearWeight = smoothstep(-.23, .23, n.z);
  if (nearWeight <= 0.) return lunarChart(farUV, farDx, farDy);
  if (nearWeight >= 1.) return lunarChart(nearUV, nearDx, nearDy);
  return mix(lunarChart(farUV, farDx, farDy), lunarChart(nearUV, nearDx, nearDy), nearWeight);
}

vec2 chartGradient(vec3 n, vec3 change) {
  float longitude = (n.z * change.x - n.x * change.z) / max(.00001, dot(n.xz, n.xz));
  float latitude = change.y / max(.001, sqrt(max(0., 1. - n.y * n.y)));
  return vec2(longitude, -latitude) / u_span;
}

float featheredBox(vec2 uv, vec2 lo, vec2 hi, float feather) {
  vec2 enter = smoothstep(lo - feather, lo, uv);
  vec2 leave = 1. - smoothstep(hi, hi + feather, uv);
  vec2 coverage = enter * leave;
  return coverage.x * coverage.y;
}

vec3 cleanFontaine(vec2 uv, vec3 terrain) {
  // The source has flat, untextured patches at these two ends of Fontaine.
  float west = featheredBox(uv, vec2(.386, .308), vec2(.498, .454), .007);
  float east = featheredBox(uv, vec2(.580, .308), vec2(.644, .429), .007);
  if (max(west, east) <= 0.) return terrain;
  vec3 rgb = terrain * 255.;
  float distanceToFill = min(
    min(length(rgb - vec3(103., 95., 89.)), length(rgb - vec3(99., 138., 82.))),
    min(length(rgb - vec3(78., 124., 63.)), length(rgb - vec3(92., 137., 85.)))
  );
  float fill = 1. - smoothstep(7., 18., distanceToFill);
  float westLimit = mix(.493, .450, smoothstep(.368, .413, uv.y));
  float eastLimit = mix(.399, .428, smoothstep(.585, .614, uv.x));
  float westCore = featheredBox(uv, vec2(.387, .306), vec2(westLimit, .438), .008);
  float eastCore = featheredBox(uv, vec2(.581, .306), vec2(.643, eastLimit), .007);
  vec3 overview = textureLod(u_atlas, uv, 0.).rgb;
  vec2 stride = 5. / vec2(textureSize(u_atlas, 0));
  vec3 horizontal = textureLod(u_atlas, uv + vec2(stride.x, 0.), 0.).rgb
    - textureLod(u_atlas, uv - vec2(stride.x, 0.), 0.).rgb;
  vec3 vertical = textureLod(u_atlas, uv + vec2(0., stride.y), 0.).rgb
    - textureLod(u_atlas, uv - vec2(0., stride.y), 0.).rgb;
  float detail = max(max(length(horizontal), length(vertical)), length(overview - terrain));
  float uniformity = 1. - smoothstep(.044, .125, detail);
  float mask = max(max(westCore, eastCore), max(west, east) * fill * uniformity);
  return mix(terrain, u_sea, mask);
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

vec3 lunarHazard(vec3 color, vec3 normal) {
  vec2 nearUV = lunarUV(normal, 1.);
  vec2 farUV = lunarUV(normal, -1.);
  bool nearSide = normal.z >= 0.;
  vec2 uv = nearSide ? nearUV : farUV;
  float level = log2(max(1., u_zoom));
  vec2 cells = vec2(190., 190. * 9. / 17.) * exp2(floor(level));
  vec2 nearWidth = fwidth(nearUV * cells);
  vec2 farWidth = fwidth(farUV * cells);
  vec2 footprint = nearSide ? nearWidth : farWidth;
  vec2 cell = uv * cells;
  // Refine the map-space lattice as the camera closes in, keeping the art readable.
  float dotMask = mix(lunarDot(cell, footprint), lunarDot(cell * 2., footprint * 2.),
    smoothstep(.38, .96, fract(level)));
  ivec2 size = textureSize(u_moonStencil, 0);
  ivec2 sourcePixel = clamp(ivec2(uv * vec2(size)), ivec2(0), size - 1);
  if (texelFetch(u_moonStencil, sourcePixel, 0).g >= .5) return color;
  vec3 stencil = textureLod(u_moonStencil, uv, 0.).rgb;
  vec3 blue = mix(vec3(.13, .44, .93), vec3(.24, .65, .99), dotMask);
  color = mix(color, blue, stencil.r * (.14 + dotMask * .67));
  return mix(color, vec3(.385, .794, .76), stencil.b * .64);
}

void main() {
  if (u_occluder.z > 0. && distance(gl_FragCoord.xy, u_occluder.xy) < u_occluder.z) discard;
  vec2 p = (gl_FragCoord.xy - u_center) / u_radius;
  float r = length(p);
  if (r >= 1.001) discard;

  vec3 ice = vec3(.49, .79, .82);

  float z = sqrt(max(0., 1. - dot(p, p)));
  vec3 n = normalize(u_right * p.x + u_up * p.y + u_front * z);
  float lon = atan(n.x, n.z);
  float lat = asin(clamp(n.y, -1., 1.));
  vec2 uv = vec2(lon / u_span.x + .5, .5 - lat / u_span.y);
  vec2 uvDx = chartGradient(n, dFdx(n));
  vec2 uvDy = chartGradient(n, dFdy(n));
  if (u_naturalMoon) {
    vec3 albedo = lunarMineral(textureGrad(u_atlas, uv, uvDx, uvDy).rgb);
    float light = smoothstep(-.52, .95, dot(vec3(p, z), normalize(vec3(-.63, .59, .64))));
    vec3 color = albedo * (.36 + light * .60) * vec3(.94, 1.02, 1.08);
    pixel = vec4(color, 1. - smoothstep(.997, 1.001, r));
    return;
  }
  if (u_projection == 2) {
    vec3 terrain = lunarTerrain(n);
    // Neutral limb shading keeps the original map colors outside the danger overlay.
    terrain *= 1. - .16 * pow(1. - z, 2.);
    pixel = vec4(lunarHazard(terrain, n), 1. - smoothstep(.997, 1.001, r));
    return;
  }
  if (u_flatten > 0.) {
    vec2 center = vec2(atan(u_front.x, u_front.z) / u_span.x + .5,
      .5 - asin(clamp(u_front.y, -1., 1.)) / u_span.y);
    vec2 chart = center + p * vec2(u_chartScale.x, -u_chartScale.y);
    uv = mix(uv, chart, u_flatten);
    uvDx = mix(uvDx, dFdx(chart), u_flatten);
    uvDy = mix(uvDy, dFdy(chart), u_flatten);
  }
  float margin = min(min(uv.x, 1. - uv.x), min(uv.y, 1. - uv.y));
  vec3 terrain = mix(u_sea, readAtlas(uv, uvDx, uvDy), smoothstep(0., .022, margin));
  terrain = applyGroundPatch(terrain, uv, uvDx, uvDy);
  if (u_cleanFontaine) terrain = cleanFontaine(uv, terrain);

  float land = smoothstep(.085, .25, length(terrain - u_sea));
  float brightness = dot(terrain, vec3(.2126, .7152, .0722));
  float sun = dot(vec3(p, z), normalize(vec3(-.63, .59, .64)));
  float daylight = smoothstep(-.52, .95, sun);
  vec3 sea = mix(vec3(.023, .059, .08), vec3(.094, .242, .276), daylight);
  sea += (terrain - u_sea) * .32;
  sea += .012 * sin(n.x * 17. + n.y * 21.) * sin(n.z * 14.);
  if (u_oceanRelief) sea += oceanRelief(n) * (.72 + .43 * daylight);
  vec3 landColor = mix(terrain, vec3(brightness * .94, brightness * 1.04, brightness * 1.04), .20);
  landColor *= (.51 + daylight * .52) * vec3(.94, 1.02, 1.08);
  vec3 rgb = mix(sea, landColor, land * .94);

  vec2 grid = vec2(lon, lat) * (12. / PI);
  vec2 gridDist = abs(fract(grid + .5) - .5);
  float lonDx = n.z * dFdx(n.x) - n.x * dFdx(n.z);
  float lonDy = n.z * dFdy(n.x) - n.x * dFdy(n.z);
  float longitudeWidth = (abs(lonDx) + abs(lonDy)) * (12. / PI) / max(.004, dot(n.xz, n.xz));
  vec2 gridWidth = clamp(vec2(longitudeWidth, fwidth(grid.y)) * .8, .001, .12);
  vec2 etched = 1. - smoothstep(gridWidth * .45, gridWidth * 1.3, gridDist);
  float graticule = max(etched.x, etched.y) * (.04 + daylight * .085) * smoothstep(.15, .6, z);
  float closeView = smoothstep(1.3, 4.4, u_zoom);
  graticule *= 1. - closeView * .92;
  rgb = mix(rgb, ice, graticule * (1. - land * .65));

  rgb = mix(rgb, vec3(.046, .102, .128), pow(1. - z, 2.6) * .43);
  float opacity = 1. - smoothstep(.997, 1.001, r);
  pixel = vec4(rgb, opacity);
}
