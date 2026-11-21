package main

import (
	"github.com/spf13/cobra"

	"example.com/core"
	"example.com/core/internal/engine"
)

func main() {
	core.NewMemory()
	engine.Run()
	_ = cobra.Command{}
}
