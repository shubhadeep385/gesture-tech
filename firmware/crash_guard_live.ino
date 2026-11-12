#include <Wire.h>
#include <MPU6050_light.h>

MPU6050 mpu(Wire);
const float JERK_THRESHOLD = 2.5;
const unsigned long COOLDOWN_MS = 3000;
unsigned long lastSample = 0;
unsigned long lastAlert = 0;
uint32_t sequence = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  if (mpu.begin() != 0) {
    while (true) {
      Serial.println("{\"type\":\"hardware:status\",\"status\":\"mpu-init-failed\"}");
      delay(1000);
    }
  }
  mpu.calcOffsets(true, true);
}

void loop() {
  if (millis() - lastSample < 50) return;
  lastSample = millis();
  mpu.update();

  const float ax = mpu.getAccX();
  const float ay = mpu.getAccY();
  const float az = mpu.getAccZ();
  const float gx = mpu.getGyroX();
  const float gy = mpu.getGyroY();
  const float gz = mpu.getGyroZ();
  const float roll = mpu.getAngleX();
  const float pitch = mpu.getAngleY();
  const float yaw = mpu.getAngleZ();
  const float totalAcc = sqrt(ax * ax + ay * ay + az * az);
  const bool alert = totalAcc > JERK_THRESHOLD && millis() - lastAlert > COOLDOWN_MS;
  if (alert) lastAlert = millis();

  Serial.print("{\"deviceId\":\"motion-01\",\"module\":\"accident_alert\",\"type\":\"sensor:update\",\"sequence\":");
  Serial.print(sequence++);
  Serial.print(",\"timestamp\":");
  Serial.print(millis());
  Serial.print(",\"source\":\"hardware\",\"accel\":{\"x\":");
  Serial.print(ax, 4);
  Serial.print(",\"y\":");
  Serial.print(ay, 4);
  Serial.print(",\"z\":");
  Serial.print(az, 4);
  Serial.print("},\"gyro\":{\"x\":");
  Serial.print(gx, 2);
  Serial.print(",\"y\":");
  Serial.print(gy, 2);
  Serial.print(",\"z\":");
  Serial.print(gz, 2);
  Serial.print("},\"orientation\":{\"x\":");
  Serial.print(roll, 2);
  Serial.print(",\"y\":");
  Serial.print(pitch, 2);
  Serial.print(",\"z\":");
  Serial.print(yaw, 2);
  if (alert) Serial.print("},\"alert\":\"ACCIDENT DETECTED\"");
  else Serial.print("}");
  Serial.println("}");
}
