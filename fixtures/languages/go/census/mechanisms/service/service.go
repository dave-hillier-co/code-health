package service

import (
	"os"
	"os/signal"

	"example.com/census/ports"
	"example.com/census/retry"
)

type Service struct {
	store ports.Store `inject:""`
	bus   Bus
}

type Bus interface {
	Publish(topic string)
}

func Run(store ports.Store, bus Bus) error {
	signal.Notify(make(chan os.Signal, 1), os.Interrupt)
	bus.Publish("started")
	return retry.Retry(3, func() error {
		_, _ = store.Get("k")
		return nil
	})
}
