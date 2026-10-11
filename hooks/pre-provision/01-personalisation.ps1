$adv = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
Set-ItemProperty -Path $adv -Name TaskbarAl -Value 0 -Type DWord
Set-ItemProperty -Path $adv -Name Hidden -Value 1 -Type DWord

$search = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Search'
New-Item -Path $search -Force | Out-Null
Set-ItemProperty -Path $search -Name SearchboxTaskbarMode -Value 0 -Type DWord

$theme = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
Set-ItemProperty -Path $theme -Name AppsUseLightTheme -Value 0 -Type DWord
Set-ItemProperty -Path $theme -Name SystemUsesLightTheme -Value 0 -Type DWord

Stop-Process -Name explorer -Force