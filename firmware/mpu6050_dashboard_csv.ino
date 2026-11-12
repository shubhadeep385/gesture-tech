#include <Wire.h>
#include <MPU6050_light.h>

MPU6050 mpu(Wire);
const unsigned long SAMPLE_INTERVAL_MS = 20;
unsigned long lastSample = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);

  if (mpu.begin() != 0) {
    while (true) delay(100);
  }

  mpu.calcOffsets(true, true);
}

void loop() {
  if (millis() - lastSample < SAMPLE_INTERVAL_MS) return;
  lastSample = millis();
  mpu.update();

  Serial.print("R:");
  Serial.print(mpu.getAngleX(), 1);
  Serial.print(",P:");
  Serial.print(mpu.getAngleY(), 1);
  Serial.print(",Y:");
  Serial.print(mpu.getAngleZ(), 1);
  Serial.print(",GX:");
  Serial.print(mpu.getGyroX(), 1);
  Serial.print(",GY:");
  Serial.print(mpu.getGyroY(), 1);
  Serial.print(",GZ:");
  Serial.print(mpu.getGyroZ(), 1);
  Serial.println();
}
