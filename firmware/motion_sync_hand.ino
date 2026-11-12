#include <Wire.h>
#include <MPU6050_light.h>

MPU6050 mpu(Wire);
unsigned long lastSample = 0;
uint32_t sequence = 0;
const unsigned long SAMPLE_INTERVAL_MS = 40;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);

  byte status = mpu.begin();
  if (status != 0) {
    while (true) {
      Serial.println("MPU6050_INIT_FAILED");
      delay(1000);
    }
  }

  mpu.calcOffsets(true, true);
}

void loop() {
  if (millis() - lastSample < SAMPLE_INTERVAL_MS) return;
  lastSample = millis();

  mpu.update();

  Serial.print("{\"deviceId\":\"motion-01\",\"module\":\"robot_arm\",\"type\":\"sensor:update\",\"sequence\":");
  Serial.print(sequence++);
  Serial.print(",\"timestamp\":");
  Serial.print(millis());
  Serial.print(",\"source\":\"hardware\",\"accel\":{\"x\":");
  Serial.print(mpu.getAccX(), 4);
  Serial.print(",\"y\":");
  Serial.print(mpu.getAccY(), 4);
  Serial.print(",\"z\":");
  Serial.print(mpu.getAccZ(), 4);
  Serial.print("},\"gyro\":{\"x\":");
  Serial.print(mpu.getGyroX(), 2);
  Serial.print(",\"y\":");
  Serial.print(mpu.getGyroY(), 2);
  Serial.print(",\"z\":");
  Serial.print(mpu.getGyroZ(), 2);
  Serial.print("},\"orientation\":{\"x\":");
  Serial.print(mpu.getAngleX(), 2);
  Serial.print(",\"y\":");
  Serial.print(mpu.getAngleY(), 2);
  Serial.print(",\"z\":");
  Serial.print(mpu.getAngleZ(), 2);
  Serial.println("}}");
}
