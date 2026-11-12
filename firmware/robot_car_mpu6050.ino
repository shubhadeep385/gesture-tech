#include <Wire.h>
#include <MPU6050_light.h>

MPU6050 mpu(Wire);
unsigned long lastSample = 0;
uint32_t sequence = 0;
const unsigned long SAMPLE_INTERVAL_MS = 60;
const float TILT_THRESHOLD = 10.0f;

const char* directionFor(float roll, float pitch, float ax, float ay) {
  const float accelRoll = ay * 45.0f;
  const float accelPitch = ax * 45.0f;
  if (fabs(accelPitch) >= fabs(accelRoll) && fabs(accelPitch) >= 8.0f) {
    return accelPitch < 0 ? "UP" : "DOWN";
  }
  if (fabs(accelRoll) >= 8.0f) {
    return accelRoll < 0 ? "LEFT" : "RIGHT";
  }
  if (fabs(pitch) >= fabs(roll) && fabs(pitch) >= TILT_THRESHOLD) return pitch < 0 ? "UP" : "DOWN";
  if (fabs(roll) >= TILT_THRESHOLD) return roll < 0 ? "LEFT" : "RIGHT";
  return "NONE";
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  if (mpu.begin() != 0) {
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

  const float roll = mpu.getAngleX();
  const float pitch = mpu.getAngleY();
  const float ax = mpu.getAccX();
  const float ay = mpu.getAccY();
  const float az = mpu.getAccZ();
  const char* direction = directionFor(roll, pitch, ax, ay);

  Serial.print("{\"deviceId\":\"motion-01\",\"module\":\"robot_car\",\"type\":\"sensor:update\",\"sequence\":");
  Serial.print(sequence++);
  Serial.print(",\"timestamp\":");
  Serial.print(millis());
  Serial.print(",\"source\":\"hardware\",\"direction\":\"");
  Serial.print(direction);
  Serial.print("\",\"accel\":{\"x\":");
  Serial.print(ax, 4);
  Serial.print(",\"y\":");
  Serial.print(ay, 4);
  Serial.print(",\"z\":");
  Serial.print(az, 4);
  Serial.print("},\"gyro\":{\"x\":");
  Serial.print(mpu.getGyroX(), 2);
  Serial.print(",\"y\":");
  Serial.print(mpu.getGyroY(), 2);
  Serial.print(",\"z\":");
  Serial.print(mpu.getGyroZ(), 2);
  Serial.print("},\"orientation\":{\"x\":");
  Serial.print(roll, 2);
  Serial.print(",\"y\":");
  Serial.print(pitch, 2);
  Serial.print(",\"z\":");
  Serial.print(mpu.getAngleZ(), 2);
  Serial.println("}}");
}
