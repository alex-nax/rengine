# Project image previews

The initial preview types are PNG/APNG, JPEG, GIF and WebP. Their extensions select the preview
pane; actual bytes must identify a supported image. Other binary files retain an explicit
unsupported-text result. SVG/HTML remain text so opening project files cannot execute markup.

Use the existing authenticated root-relative file boundary. Preview reads are bounded to 8 MiB
from an opened regular-file handle and at most 16,777,216 source pixels, with each dimension at
most 8,192. Reject invalid metadata before handing the encoded image to the renderer. The browser
decoder must also succeed; a valid header alone cannot imply a displayed image. No image write,
conversion or source modification occurs.

Adopt `image-dimensions` 2.5.1 (MIT, no transitive dependencies), pinned with npm integrity, for
encoded-image metadata. Its [official API](https://github.com/sindresorhus/image-dimensions)
returns raw dimensions and format from byte data. The browser handles decoding, animation and
EXIF orientation. Displayed dimensions come from the decoded image; source dimensions bound the
resource check. An image may be refreshed explicitly after an external edit.

Each tab stores its root and relative path, independent of focused project. Fetch bytes using the
normal bearer header, then display an object URL; do not put credentials in image URLs. Abort
pending reads and revoke object URLs when replacing/detaching a view. Show fit/actual-size modes,
the file path and dimensions. A failed refresh shows a visible error and permits retry.

Acceptance uses actual Electron image decoding with different pixels under identical filenames
in two roots, tab move and GUI restart. The HTTP check covers authentication, traversal/external
symlinks, invalid or unsupported bytes, oversized files and oversized dimensions. Decode failure
must appear in the pane. Windows and the remaining editor/persistence criteria stay open until
their own runtime checks pass.
