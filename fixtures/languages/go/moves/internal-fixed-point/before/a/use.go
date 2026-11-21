package a

import "example.com/m/a/internal/secret"

func Key() string {
	return secret.Key()
}
