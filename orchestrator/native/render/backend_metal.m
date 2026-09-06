#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#include <SDL_metal.h>
#include "render/backend_metal.h"
#include "render/utf8.h"
#include <stdlib.h>
#include <string.h>

#define ATLAS_SIZE 2048
#define GLYPH_SLOTS 4096
#define BATCH_VERTICES 65536
enum { MODE_SOLID = 0, MODE_FILL = 1, MODE_RING = 2, MODE_SHADOW = 3, MODE_COVERAGE = 4, MODE_RGBA = 5 };

/* float4 attributes first so their offsets are 16-byte aligned; 60-byte stride. */
typedef struct { float shape[4]; float radii[4]; float pos[2]; float uv[2]; float extra[2]; uint8_t color[4]; } Vertex;
typedef struct { uint32_t codepoint; uint8_t face; int16_t size; bool used, present; int ax, ay, w, h, dx, dy; } Glyph;
typedef struct { ReTexture base; void *texture; } MetalTexture;

@interface ReMetalObjects : NSObject
@property (strong) id<MTLDevice> device;
@property (strong) id<MTLCommandQueue> queue;
@property (strong) id<MTLRenderPipelineState> pipeline;
@property (strong) id<MTLSamplerState> sampler;
@property (strong) id<MTLTexture> atlas;
@property (strong) CAMetalLayer *layer;
@property (strong) id<MTLCommandBuffer> commands;
@property (strong) id<MTLRenderCommandEncoder> encoder;
@property (strong) id<CAMetalDrawable> drawable;
@end
@implementation ReMetalObjects
@end

typedef struct {
  ReBackend base; SDL_Window *window; SDL_MetalView view; void *objects; float density; int dw, dh;
  Vertex *vertices; size_t count; void *bound; bool encoding, committed;
  Glyph glyphs[GLYPH_SLOTS]; int shelf_x, shelf_y, shelf_h;
} MetalBackend;

static ReMetalObjects *objects(MetalBackend *b) { return (__bridge ReMetalObjects *)b->objects; }

/* Same shading as the OpenGL adapter — see sidecar: shared-shading */
static const char *shader_source =
  "#include <metal_stdlib>\n"
  "using namespace metal;\n"
  "struct VertexIn { float4 shape [[attribute(0)]]; float4 radii [[attribute(1)]]; float2 pos [[attribute(2)]];\n"
  "                  float2 uv [[attribute(3)]]; float2 extra [[attribute(4)]]; float4 color [[attribute(5)]]; };\n"
  "struct VertexOut { float4 position [[position]]; float2 pos; float2 uv; float4 color;\n"
  "                   float4 shape [[flat]]; float4 radii [[flat]]; float2 extra [[flat]]; };\n"
  "vertex VertexOut vertex_main(VertexIn in [[stage_in]], constant float2 &size [[buffer(1)]]) {\n"
  "  VertexOut out; out.position = float4(in.pos.x / size.x * 2.0 - 1.0, 1.0 - in.pos.y / size.y * 2.0, 0.0, 1.0);\n"
  "  out.pos = in.pos; out.uv = in.uv; out.color = in.color; out.shape = in.shape; out.radii = in.radii; out.extra = in.extra; return out;\n"
  "}\n"
  "static float box(float2 p, float2 h, float r) { float2 q = abs(p) - (h - float2(r)); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }\n"
  "static float corner(float2 p, float4 radii) { return p.x < 0.0 ? (p.y < 0.0 ? radii.x : radii.w) : (p.y < 0.0 ? radii.y : radii.z); }\n"
  "fragment float4 fragment_main(VertexOut in [[stage_in]], texture2d<float> tex [[texture(0)]], sampler smp [[sampler(0)]]) {\n"
  "  int mode = int(in.extra.y + 0.5); float4 c = in.color; float2 p = in.pos - in.shape.xy; float2 h = in.shape.zw; float w = in.extra.x;\n"
  "  if (mode == 1) { c.a *= clamp(0.5 - box(p, h, corner(p, in.radii)), 0.0, 1.0); }\n"
  "  else if (mode == 2) { float r = corner(p, in.radii); float o = clamp(0.5 - box(p, h, r), 0.0, 1.0);\n"
  "    float i = clamp(0.5 - box(p, h - float2(w), max(r - w, 0.0)), 0.0, 1.0); c.a *= o * (1.0 - i); }\n"
  "  else if (mode == 3) { c.a *= 1.0 - smoothstep(0.0, w, box(p, h, corner(p, in.radii))); }\n"
  "  else if (mode == 4) { c.a *= tex.sample(smp, in.uv).r; }\n"
  "  else if (mode == 5) { c *= tex.sample(smp, in.uv); }\n"
  "  if (c.a <= 0.0) discard_fragment();\n"
  "  return c;\n"
  "}\n";

static void set_error(const char *what, NSError *error) {
  SDL_SetError("%s: %s", what, error ? error.localizedDescription.UTF8String : "unknown Metal error");
}
static void flush(MetalBackend *b) {
  if (!b->count || !b->encoding) { b->count = 0; return; }
  ReMetalObjects *o = objects(b);
  id<MTLBuffer> buffer = [o.device newBufferWithBytes:b->vertices length:b->count * sizeof(Vertex) options:MTLResourceStorageModeShared];
  [o.encoder setVertexBuffer:buffer offset:0 atIndex:0];
  [o.encoder setFragmentTexture:(b->bound ? (__bridge id<MTLTexture>)b->bound : o.atlas) atIndex:0];
  [o.encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:b->count];
  b->count = 0;
}
static void bind(MetalBackend *b, void *texture) { if (texture != b->bound) { flush(b); b->bound = texture; } }
static void emit(MetalBackend *b, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, ReColor c,
                 float cx, float cy, float hw, float hh, const float radii[4], float w, int mode) {
  if (b->count + 6 > BATCH_VERTICES) flush(b);
  Vertex *v = b->vertices + b->count; b->count += 6;
  float xs[6] = {x0, x1, x1, x0, x1, x0}, ys[6] = {y0, y0, y1, y0, y1, y1};
  float us[6] = {u0, u1, u1, u0, u1, u0}, vs[6] = {v0, v0, v1, v0, v1, v1};
  for (int i = 0; i < 6; i++) {
    v[i].pos[0] = xs[i]; v[i].pos[1] = ys[i]; v[i].uv[0] = us[i]; v[i].uv[1] = vs[i];
    v[i].color[0] = c.r; v[i].color[1] = c.g; v[i].color[2] = c.b; v[i].color[3] = c.a;
    v[i].shape[0] = cx; v[i].shape[1] = cy; v[i].shape[2] = hw; v[i].shape[3] = hh;
    memcpy(v[i].radii, radii, sizeof(float) * 4); v[i].extra[0] = w; v[i].extra[1] = (float)mode;
  }
}
static void shape(MetalBackend *b, ReRect r, ReColor c, float radius, uint8_t corners, float w, int mode, int expand) {
  float d = b->density, x0 = (float)(r.x - expand) * d, y0 = (float)(r.y - expand) * d, x1 = (float)(r.x + r.w + expand) * d, y1 = (float)(r.y + r.h + expand) * d;
  float radii[4] = {corners & RE_CORNER_TOP_LEFT ? radius * d : 0, corners & RE_CORNER_TOP_RIGHT ? radius * d : 0,
                    corners & RE_CORNER_BOTTOM_RIGHT ? radius * d : 0, corners & RE_CORNER_BOTTOM_LEFT ? radius * d : 0};
  float cx = (float)r.x * d + (float)r.w * d / 2, cy = (float)r.y * d + (float)r.h * d / 2, hw = (float)r.w * d / 2, hh = (float)r.h * d / 2;
  if (mode == MODE_RING) { hw += (float)expand * d; hh += (float)expand * d; for (int i = 0; i < 4; i++) radii[i] += (float)expand * d; }
  emit(b, x0, y0, x1, y1, 0, 0, 0, 0, c, cx, cy, hw, hh, radii, w * d, mode);
}

static void atlas_reset(MetalBackend *b) { memset(b->glyphs, 0, sizeof(b->glyphs)); b->shelf_x = b->shelf_y = b->shelf_h = 0; }
static bool atlas_place(MetalBackend *b, int w, int h, int *x, int *y) {
  if (b->shelf_x + w + 1 > ATLAS_SIZE) { b->shelf_y += b->shelf_h + 1; b->shelf_x = 0; b->shelf_h = 0; }
  if (b->shelf_y + h + 1 > ATLAS_SIZE || w + 1 > ATLAS_SIZE) return false;
  *x = b->shelf_x; *y = b->shelf_y; b->shelf_x += w + 1; if (h > b->shelf_h) b->shelf_h = h; return true;
}
static Glyph *glyph(MetalBackend *b, uint8_t face, int16_t size, uint32_t cp) {
  Glyph *g = &b->glyphs[(cp * 31u + face * 7919u + (uint32_t)size * 131u) % GLYPH_SLOTS];
  if (g->used && g->codepoint == cp && g->face == face && g->size == size) return g;
  ReGlyphBitmap bitmap;
  bool raster = re_font_glyph(b->base.fonts, face, size, b->density, cp, &bitmap);
  for (int attempt = 0; attempt < 2; attempt++) {
    memset(g, 0, sizeof(*g)); g->used = true; g->codepoint = cp; g->face = face; g->size = size;
    if (!raster || !bitmap.w || !bitmap.h) break;
    if (atlas_place(b, bitmap.w, bitmap.h, &g->ax, &g->ay)) {
      g->w = bitmap.w; g->h = bitmap.h; g->dx = bitmap.dx; g->dy = bitmap.dy; g->present = true;
      [objects(b).atlas replaceRegion:MTLRegionMake2D((NSUInteger)g->ax, (NSUInteger)g->ay, (NSUInteger)g->w, (NSUInteger)g->h)
                          mipmapLevel:0 withBytes:bitmap.pixels bytesPerRow:(NSUInteger)g->w];
      break;
    }
    flush(b); atlas_reset(b);
  }
  if (raster) re_font_glyph_free(&bitmap);
  return g;
}
/* Glyph placement matches the SDL reference and the OpenGL adapter exactly — see sidecar: shared-shading */
static void draw_text(MetalBackend *b, ReColor color, uint8_t face, int size, int x, int y, const char *s, const char *end) {
  ReFontMetrics m = re_font_metrics(b->base.fonts, face, size, b->density);
  float d = b->density, base = (float)(y + m.ascent + 2) * d;
  ReTextPen pen = re_font_pen(b->base.fonts, face, size, d, x);
  bind(b, NULL);
  while (*s && s < end) {
    uint32_t cp = re_utf8(&s); Glyph *g = glyph(b, face, (int16_t)size, cp);
    if (g->present) {
      float gx = re_font_pen_x(&pen) + (float)g->dx, gy = base + (float)g->dy, radii[4] = {0, 0, 0, 0};
      emit(b, gx, gy, gx + (float)g->w, gy + (float)g->h, (float)g->ax / ATLAS_SIZE, (float)g->ay / ATLAS_SIZE,
           (float)(g->ax + g->w) / ATLAS_SIZE, (float)(g->ay + g->h) / ATLAS_SIZE, color, 0, 0, 0, 0, radii, 0, MODE_COVERAGE);
    }
    re_font_pen_step(&pen, cp);
  }
}
static void set_clip(MetalBackend *b, const ReCommand *c) {
  flush(b);
  MTLScissorRect rect = {0, 0, (NSUInteger)b->dw, (NSUInteger)b->dh};
  if (!(c->flags & RE_CLIP_RESET)) {
    int w = c->rect.w > 0 ? c->rect.w : 0, h = c->rect.h > 0 ? c->rect.h : 0;
    int x0 = (int)((float)c->rect.x * b->density), y0 = (int)((float)c->rect.y * b->density);
    int x1 = (int)((float)(c->rect.x + w) * b->density), y1 = (int)((float)(c->rect.y + h) * b->density);
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 > b->dw) x1 = b->dw; if (y1 > b->dh) y1 = b->dh;
    if (x1 < x0) x1 = x0; if (y1 < y0) y1 = y0;
    rect.x = (NSUInteger)x0; rect.y = (NSUInteger)y0; rect.width = (NSUInteger)(x1 - x0); rect.height = (NSUInteger)(y1 - y0);
  }
  [objects(b).encoder setScissorRect:rect];
}

static float density(ReBackend *backend, int logical_width) {
  MetalBackend *b = (MetalBackend *)backend; int dw, dh; SDL_Metal_GetDrawableSize(b->window, &dw, &dh);
  return (float)dw / (logical_width > 1 ? logical_width : 1);
}
static void finish_encoding(MetalBackend *b) {
  if (b->encoding) { flush(b); [objects(b).encoder endEncoding]; b->encoding = false; }
}
static bool begin(ReBackend *backend, const ReDrawList *list) {
  MetalBackend *b = (MetalBackend *)backend; ReMetalObjects *o = objects(b);
  SDL_Metal_GetDrawableSize(b->window, &b->dw, &b->dh);
  if (b->dw < 1 || b->dh < 1) return false;
  o.layer.drawableSize = CGSizeMake(b->dw, b->dh);
  if (list->density != b->density) { b->density = list->density; atlas_reset(b); }
  o.drawable = [o.layer nextDrawable];
  if (!o.drawable) return false;
  o.commands = [o.queue commandBuffer];
  MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
  pass.colorAttachments[0].texture = o.drawable.texture;
  pass.colorAttachments[0].loadAction = MTLLoadActionClear;
  pass.colorAttachments[0].storeAction = MTLStoreActionStore;
  pass.colorAttachments[0].clearColor = MTLClearColorMake(list->clear.r / 255.0, list->clear.g / 255.0, list->clear.b / 255.0, list->clear.a / 255.0);
  o.encoder = [o.commands renderCommandEncoderWithDescriptor:pass];
  [o.encoder setRenderPipelineState:o.pipeline];
  [o.encoder setViewport:(MTLViewport){0, 0, (double)b->dw, (double)b->dh, 0, 1}];
  [o.encoder setFragmentSamplerState:o.sampler atIndex:0];
  float size[2] = {(float)b->dw, (float)b->dh};
  [o.encoder setVertexBytes:size length:sizeof(size) atIndex:1];
  b->encoding = true; b->committed = false; b->count = 0; b->bound = NULL;
  return true;
}
static void execute(ReBackend *backend, const ReDrawList *list) {
  MetalBackend *b = (MetalBackend *)backend; static const float none[4] = {0, 0, 0, 0};
  if (!b->encoding) return;
  for (size_t i = 0; i < list->count; i++) {
    const ReCommand *c = &list->commands[i]; float d = b->density;
    switch (c->type) {
      case RE_CMD_CLIP: set_clip(b, c); break;
      case RE_CMD_RECT: bind(b, NULL); shape(b, c->rect, c->color, 0, 0, 0, MODE_SOLID, 0); break;
      case RE_CMD_RRECT: bind(b, NULL); shape(b, c->rect, c->color, c->radius, c->corners, 0, c->radius > 0 && c->corners ? MODE_FILL : MODE_SOLID, 0); break;
      case RE_CMD_FRAME:
        bind(b, NULL); shape(b, c->rect, c->color, c->radius, c->corners, 1, MODE_RING, 0);
        if (c->secondary.a) {
          int rad = (int)c->radius; if (rad > c->rect.w / 2) rad = c->rect.w / 2; if (rad > c->rect.h / 2) rad = c->rect.h / 2;
          shape(b, re_rect(c->rect.x + 1 + rad, c->rect.y + 1, c->rect.w - 2 - 2 * rad, 1), c->secondary, 0, 0, 0, MODE_SOLID, 0);
        }
        break;
      case RE_CMD_SHADOW: bind(b, NULL); shape(b, c->rect, c->color, c->radius, c->corners, (float)c->width, MODE_SHADOW, c->width); break;
      case RE_CMD_RING: bind(b, NULL); shape(b, c->rect, c->color, c->radius, c->corners, (float)c->width, MODE_RING, c->width); break;
      case RE_CMD_TEXT: { const char *s = re_draw_list_string(list, c); draw_text(b, c->color, c->face, c->size > 0 ? c->size : 16, c->rect.x, c->rect.y, s, s + c->text_length); break; }
      case RE_CMD_ICON: {
        char glyph[5]; int size = c->size > 0 ? c->size : 16;
        int length = re_encode(re_icon_codepoints[c->icon < RE_ICON_COUNT ? c->icon : RE_ICON_UNKNOWN], glyph);
        ReFontMetrics m = re_font_metrics(b->base.fonts, RE_FACE_ICON, size, d);
        int width = re_font_text_width(b->base.fonts, RE_FACE_ICON, size, d, glyph, length);
        draw_text(b, c->color, RE_FACE_ICON, size, c->rect.x + (c->rect.w - width) / 2, c->rect.y + (c->rect.h - m.line_height) / 2, glyph, glyph + length);
        break;
      }
      case RE_CMD_TEXTURE: {
        MetalTexture *t = (MetalTexture *)c->texture; if (!t) break;
        bind(b, t->texture); bool flip = (c->flags & RE_DRAW_FLIP_Y) != 0;
        emit(b, (float)c->rect.x * d, (float)c->rect.y * d, (float)(c->rect.x + c->rect.w) * d, (float)(c->rect.y + c->rect.h) * d,
             0, flip ? 1.0f : 0.0f, 1, flip ? 0.0f : 1.0f, re_color(255, 255, 255, 255), 0, 0, 0, 0, none, 0, MODE_RGBA);
        break;
      }
      default: break;
    }
  }
  finish_encoding(b);
}
static void present(ReBackend *backend) {
  MetalBackend *b = (MetalBackend *)backend; ReMetalObjects *o = objects(b);
  finish_encoding(b);
  if (!o.commands || !o.drawable) return;
  if (!b->committed) { [o.commands presentDrawable:o.drawable]; [o.commands commit]; b->committed = true; }
  else [o.drawable present];
  o.encoder = nil; o.commands = nil; o.drawable = nil;
}
static bool snapshot(ReBackend *backend, const char *path) {
  MetalBackend *b = (MetalBackend *)backend; ReMetalObjects *o = objects(b);
  finish_encoding(b);
  if (!o.commands || !o.drawable) return false;
  if (!b->committed) { [o.commands commit]; b->committed = true; }
  [o.commands waitUntilCompleted];
  int w = b->dw, h = b->dh;
  SDL_Surface *s = SDL_CreateRGBSurfaceWithFormat(0, w, h, 32, SDL_PIXELFORMAT_BGRA32);
  if (!s) return false;
  [o.drawable.texture getBytes:s->pixels bytesPerRow:(NSUInteger)s->pitch fromRegion:MTLRegionMake2D(0, 0, (NSUInteger)w, (NSUInteger)h) mipmapLevel:0];
  bool ok = SDL_SaveBMP(s, path) == 0; SDL_FreeSurface(s); return ok;
}
static id<MTLTexture> make_texture(ReMetalObjects *o, MTLPixelFormat format, int width, int height) {
  MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:(NSUInteger)width height:(NSUInteger)height mipmapped:NO];
  desc.usage = MTLTextureUsageShaderRead;
  desc.storageMode = o.device.hasUnifiedMemory ? MTLStorageModeShared : MTLStorageModeManaged;
  return [o.device newTextureWithDescriptor:desc];
}
static ReTexture *texture_create(ReBackend *backend, int width, int height) {
  MetalBackend *b = (MetalBackend *)backend;
  id<MTLTexture> texture = make_texture(objects(b), MTLPixelFormatRGBA8Unorm, width, height);
  if (!texture) return NULL;
  MetalTexture *t = calloc(1, sizeof(*t)); if (!t) return NULL;
  t->texture = (__bridge_retained void *)texture; t->base.owner = backend; t->base.width = width; t->base.height = height;
  return &t->base;
}
static bool texture_update(ReTexture *texture, const void *rgba, int pitch) {
  MetalTexture *t = (MetalTexture *)texture; if (!t || pitch != texture->width * 4) return false;
  [(__bridge id<MTLTexture>)t->texture replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)texture->width, (NSUInteger)texture->height)
                                          mipmapLevel:0 withBytes:rgba bytesPerRow:(NSUInteger)pitch];
  return true;
}
static void texture_destroy(ReTexture *texture) {
  MetalTexture *t = (MetalTexture *)texture; if (!t) return;
  CFBridgingRelease(t->texture); free(t);
}
static void close_backend(ReBackend *backend) {
  MetalBackend *b = (MetalBackend *)backend; if (!b) return;
  if (b->objects) {
    finish_encoding(b);
    ReMetalObjects *o = (__bridge_transfer ReMetalObjects *)b->objects; b->objects = NULL;
    o.encoder = nil; o.commands = nil; o.drawable = nil; o = nil;
  }
  if (b->view) SDL_Metal_DestroyView(b->view);
  free(b->vertices); free(b);
}
static const ReBackendOps ops = {"metal", density, begin, execute, present, snapshot, texture_create, texture_update, texture_destroy, close_backend};

Uint32 re_backend_metal_window_flags(void) { return SDL_WINDOW_METAL; }

ReBackend *re_backend_metal_open(SDL_Window *window, ReFontSet *fonts) {
  MetalBackend *b = calloc(1, sizeof(*b)); if (!b) return NULL;
  b->window = window; b->base.ops = &ops; b->base.fonts = fonts; b->density = 1.0f;
  ReMetalObjects *o = [ReMetalObjects new];
  o.device = MTLCreateSystemDefaultDevice();
  if (!o.device) { SDL_SetError("No Metal device is available"); close_backend(&b->base); return NULL; }
  b->view = SDL_Metal_CreateView(window);
  if (!b->view) { close_backend(&b->base); return NULL; }
  o.layer = (__bridge CAMetalLayer *)SDL_Metal_GetLayer(b->view);
  if (!o.layer) { SDL_SetError("SDL did not provide a CAMetalLayer"); close_backend(&b->base); return NULL; }
  o.layer.device = o.device; o.layer.pixelFormat = MTLPixelFormatBGRA8Unorm; o.layer.framebufferOnly = NO; o.layer.displaySyncEnabled = YES;
  o.queue = [o.device newCommandQueue];
  NSError *error = nil;
  id<MTLLibrary> library = [o.device newLibraryWithSource:[NSString stringWithUTF8String:shader_source] options:nil error:&error];
  if (!library) { set_error("Metal shader compilation failed", error); close_backend(&b->base); return NULL; }
  MTLVertexDescriptor *vd = [MTLVertexDescriptor vertexDescriptor];
  MTLVertexFormat formats[6] = {MTLVertexFormatFloat4, MTLVertexFormatFloat4, MTLVertexFormatFloat2, MTLVertexFormatFloat2, MTLVertexFormatFloat2, MTLVertexFormatUChar4Normalized};
  NSUInteger offsets[6] = {offsetof(Vertex, shape), offsetof(Vertex, radii), offsetof(Vertex, pos), offsetof(Vertex, uv), offsetof(Vertex, extra), offsetof(Vertex, color)};
  for (NSUInteger i = 0; i < 6; i++) { vd.attributes[i].format = formats[i]; vd.attributes[i].offset = offsets[i]; vd.attributes[i].bufferIndex = 0; }
  vd.layouts[0].stride = sizeof(Vertex); vd.layouts[0].stepFunction = MTLVertexStepFunctionPerVertex;
  MTLRenderPipelineDescriptor *pd = [MTLRenderPipelineDescriptor new];
  pd.vertexFunction = [library newFunctionWithName:@"vertex_main"];
  pd.fragmentFunction = [library newFunctionWithName:@"fragment_main"];
  pd.vertexDescriptor = vd;
  pd.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm;
  pd.colorAttachments[0].blendingEnabled = YES;
  pd.colorAttachments[0].sourceRGBBlendFactor = MTLBlendFactorSourceAlpha;
  pd.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
  pd.colorAttachments[0].sourceAlphaBlendFactor = MTLBlendFactorOne;
  pd.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
  o.pipeline = [o.device newRenderPipelineStateWithDescriptor:pd error:&error];
  if (!o.pipeline) { set_error("Metal pipeline creation failed", error); close_backend(&b->base); return NULL; }
  MTLSamplerDescriptor *sd = [MTLSamplerDescriptor new];
  sd.minFilter = MTLSamplerMinMagFilterNearest; sd.magFilter = MTLSamplerMinMagFilterNearest;
  sd.sAddressMode = MTLSamplerAddressModeClampToEdge; sd.tAddressMode = MTLSamplerAddressModeClampToEdge;
  o.sampler = [o.device newSamplerStateWithDescriptor:sd];
  o.atlas = make_texture(o, MTLPixelFormatR8Unorm, ATLAS_SIZE, ATLAS_SIZE);
  if (!o.sampler || !o.atlas) { SDL_SetError("Metal sampler or atlas creation failed"); close_backend(&b->base); return NULL; }
  b->vertices = malloc(sizeof(Vertex) * BATCH_VERTICES);
  if (!b->vertices) { SDL_SetError("Cannot allocate the Metal vertex batch"); close_backend(&b->base); return NULL; }
  b->objects = (__bridge_retained void *)o;
  atlas_reset(b);
  return &b->base;
}
