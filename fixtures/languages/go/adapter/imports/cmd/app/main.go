package main

import (
	"fmt"
	id "github.com/google/uuid"
	. "example.com/app/util"
	_ "example.com/app/plugins"
	"example.com/app/missing"
)

func main() {
	fmt.Println(Join("a", "b"), id.New(), missing.Nothing())
}
