@echo off
echo connect to Raspberry Pi...

:: 直接執行 SSH
:: -o ConnectTimeout=5 : 設定如果 5 秒連不上就視為失敗 (避免卡太久)
:: -o StrictHostKeyChecking=no : 自動接受指紋
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no nfc@raspberrypi.local "lsof -t -i:8000 | xargs -r kill -9; bash /home/nfc/pn7160_dev/awan_nfc_tester/backend/run_server.sh"

:: 如果連線結束或失敗，暫停讓你看結果
echo.
if errorlevel 1 (
    echo [Error] Connect fail, please check the network.
) else (
    echo [成功] 連線作業已結束。
)


echo.
echo Script execution finished. Press any key to exit.
pause