// Command icongen makes the app's icons from their sources in art/:
//
//   - resources/icon.png, the app icon: art/ivy.webp (Ivy, drawn with ChatGPT's image tool)
//     in a macOS rounded square, 824 pixels on a 1024 canvas with a soft shadow, as the
//     system's own icons are laid out. The square's corners cover the artwork's own.
//   - resources/tray.png, the menu-bar icon: art/tray.webp, an ivy leaf like the one on her
//     hair clip (drawn with the same tool), black on white. A leaf reads at the menu bar's
//     18 points where a face doesn't, so its veins and stalk are drawn thick. The black is
//     kept as ink, cut to its edges and made 36 pixels tall: a template image, which
//     macOS tints for light and dark menu bars.
//
// Run it from the app folder after changing a source: go run ./tools/icongen
package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	canvas = 1024
	square = 824 // Apple's icon grid: the shape in a 1024 canvas
	radius = 185 // its corner radius, about 22.5% of the shape
	trayPx = 36  // the menu-bar icon's height: 18 points at 2x
)

func main() {
	art := load("art/ivy.webp")
	if err := writePNG("resources/icon.png", appIcon(art)); err != nil {
		log.Fatal(err)
	}
	if err := writePNG("resources/tray.png", trayIcon(load("art/tray.webp"))); err != nil {
		log.Fatal(err)
	}
}

func load(path string) image.Image {
	f, err := os.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	art, _, err := image.Decode(f)
	if err != nil {
		log.Fatal(err)
	}
	return art
}

func appIcon(art image.Image) image.Image {
	// The artwork, scaled to the square.
	scaled := image.NewNRGBA(image.Rect(0, 0, square, square))
	draw.CatmullRom.Scale(scaled, scaled.Bounds(), art, art.Bounds(), draw.Src, nil)

	out := image.NewNRGBA(image.Rect(0, 0, canvas, canvas))
	off := (canvas - square) / 2
	// A soft shadow below the square, then the square itself, both with smooth corners.
	shadow := blur(roundedMask(canvas, float64(off), float64(off+12), square, radius), 14)
	for y := range canvas {
		for x := range canvas {
			a := float64(shadow.AlphaAt(x, y).A) / 255 * 0.32
			i := out.PixOffset(x, y)
			out.Pix[i+3] = uint8(255 * a)
		}
	}
	shape := roundedMask(canvas, float64(off), float64(off), square, radius)
	for y := range canvas {
		for x := range canvas {
			cover := float64(shape.AlphaAt(x, y).A) / 255
			if cover == 0 {
				continue
			}
			c := scaled.NRGBAAt(x-off, y-off)
			i := out.PixOffset(x, y)
			below := float64(out.Pix[i+3]) / 255 // the shadow, black
			alpha := cover + below*(1-cover)
			for k, v := range []uint8{c.R, c.G, c.B} {
				out.Pix[i+k] = uint8(float64(v) * cover / alpha)
			}
			out.Pix[i+3] = uint8(255 * alpha)
		}
	}
	return out
}

// roundedMask is a square of side size at (x0, y0) with corners of radius r, with one-pixel
// soft edges, on a canvas of n pixels.
func roundedMask(n int, x0, y0, size, r float64) *image.Alpha {
	m := image.NewAlpha(image.Rect(0, 0, n, n))
	for y := range n {
		for x := range n {
			px, py := float64(x)+0.5, float64(y)+0.5
			cx := math.Max(x0+r, math.Min(x0+size-r, px))
			cy := math.Max(y0+r, math.Min(y0+size-r, py))
			d := math.Hypot(px-cx, py-cy) - r
			if px < x0 || px > x0+size || py < y0 || py > y0+size {
				d = math.Max(d, 0.5)
			}
			m.SetAlpha(x, y, color.Alpha{A: uint8(255 * math.Max(0, math.Min(1, 0.5-d)))})
		}
	}
	return m
}

// blur softens a mask with three box blurs, close to a Gaussian.
func blur(m *image.Alpha, r int) *image.Alpha {
	for range 3 {
		m = boxBlur(m, r, true)
		m = boxBlur(m, r, false)
	}
	return m
}

func boxBlur(m *image.Alpha, r int, horizontal bool) *image.Alpha {
	b := m.Bounds()
	out := image.NewAlpha(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			sum, n := 0, 0
			for d := -r; d <= r; d++ {
				sx, sy := x, y
				if horizontal {
					sx += d
				} else {
					sy += d
				}
				if image.Pt(sx, sy).In(b) {
					sum += int(m.AlphaAt(sx, sy).A)
					n++
				}
			}
			out.SetAlpha(x, y, color.Alpha{A: uint8(sum / n)})
		}
	}
	return out
}

// trayIcon keeps the artwork's dark pixels as ink, so the background and the veins read
// as clear, and fits the ink to trayPx in height.
func trayIcon(art image.Image) image.Image {
	b := art.Bounds()
	ink := image.NewAlpha(b)
	edges := image.Rectangle{}
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			// Dark and opaque is ink; a transparent background counts as white.
			r, g, bl, a := art.At(x, y).RGBA()
			if light := (r+g+bl)/3 + 0xffff - a; light < 0x8000 {
				ink.SetAlpha(x, y, color.Alpha{A: 255})
				edges = edges.Union(image.Rect(x, y, x+1, y+1))
			}
		}
	}
	if edges.Empty() {
		log.Fatal("the menu-bar artwork has no dark pixels")
	}
	w := (trayPx*edges.Dx() + edges.Dy() - 1) / edges.Dy()
	small := image.NewAlpha(image.Rect(0, 0, w, trayPx))
	draw.CatmullRom.Scale(small, small.Bounds(), ink, edges, draw.Src, nil)
	img := image.NewNRGBA(small.Bounds())
	draw.DrawMask(img, img.Bounds(), image.NewUniform(color.Black), image.Point{}, small, image.Point{}, draw.Src)
	return img
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}
