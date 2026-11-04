@echo off
REM OPTIONAL. Lets phones/laptops on your PRIVATE network reach Leash on port 3000.
REM Right-click this file > "Run as administrator". Only needed if other devices can't connect.
REM To undo later:  netsh advfirewall firewall delete rule name="Leash (port 3000)"
net session >nul 2>&1 || (echo Please right-click this file and choose "Run as administrator". & pause & exit /b 1)
netsh advfirewall firewall add rule name="Leash (port 3000)" dir=in action=allow protocol=TCP localport=3000 profile=private
echo Done. Devices on your private Wi-Fi can now open http://YOUR-PC-IP:3000
pause
