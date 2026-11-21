package depth

type Store interface {
	Get(key string) (string, bool)
	Put(key, value string)
	Closer
}

type Options struct {
	Retries int
	timeout int
	Logger
}

func (o Options) Wait() int { return o.timeout }

func (o Options) hidden() int { return o.timeout }

func Empty() {}
