#include <Wire.h>

const uint8_t MPU6050_ADDRESS = 0x68;
const char* DEVICE_ID = "motion-01";
const unsigned long SAMPLE_INTERVAL_MS = 80;
unsigned long lastSample = 0;
uint32_t sequence = 0;

int16_t readWord(uint8_t reg) {
  Wire.beginTransmission(MPU6050_ADDRESS);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(MPU6050_ADDRESS, (uint8_t)2);
  return (int16_t)((Wire.read() << 8) | Wire.read());
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.beginTransmission(MPU6050_ADDRESS);
  Wire.write(0x6B);
  Wire.write(0);
  Wire.endTransmission(true);
  Serial.println("{\"type\":\"hardware:status\",\"deviceId\":\"motion-01\",\"status\":\"ready\"}");
}

void loop() {
  if (millis() - lastSample < SAMPLE_INTERVAL_MS) return;
  lastSample = millis();

  const float ax = readWord(0x3B) / 16384.0f;
  const float ay = readWord(0x3D) / 16384.0f;
  const float az = readWord(0x3F) / 16384.0f;
  const float gx = readWord(0x43) / 131.0f;
  const float gy = readWord(0x45) / 131.0f;
  const float gz = readWord(0x47) / 131.0f;

  Serial.print("{\"deviceId\":\"");
  Serial.print(DEVICE_ID);
  Serial.print("\",\"type\":\"sensor:update\",\"sequence\":");
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
  Serial.println("}}");
}
