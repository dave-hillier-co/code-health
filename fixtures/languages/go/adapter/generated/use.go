//go:build linux

package gen

func Describe(code int) string {
	return "code " + Name(code)
}
