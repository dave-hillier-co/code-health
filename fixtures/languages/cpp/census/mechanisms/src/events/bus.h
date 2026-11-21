#pragma once

class Bus : public QObject {
 public:
  void changed(int value);
};
