package units

type Shape interface {
	Area() float64
}

type Rect struct {
	W, H float64
}

type Celsius float64

type (
	Point struct{ X, Y int }
	Named interface{ Name() string }
)

func (r Rect) Area() float64 { return r.W * r.H }

func (r *Rect) Scale(k float64) {
	r.W *= k
	r.H *= k
}

func New(w, h float64) Rect {
	grow := func(v float64) float64 { return v * 2 }
	return Rect{W: grow(w), H: grow(h)}
}

var Handler = func(s Shape) float64 {
	return s.Area()
}

func init() {}

func init() {}
