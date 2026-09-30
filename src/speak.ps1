$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$text = [Console]::In.ReadToEnd()
$voice = New-Object -ComObject SAPI.SpVoice
$voices = @($voice.GetVoices())
if ($env:CHATGPT_BUTTON_VOICE) {
  $matching = @($voices | Where-Object { $_.GetDescription() -like "*$env:CHATGPT_BUTTON_VOICE*" })
  if ($matching.Count -eq 0) { throw "SAPI voice not found: $env:CHATGPT_BUTTON_VOICE" }
} else {
  $matching = @($voices | Where-Object { $_.GetAttribute('Language') -match '(^|;)0*415(;|$)' })
  if ($matching.Count -eq 0) { throw 'No Polish SAPI voice found. Install one or set CHATGPT_BUTTON_VOICE in .env.' }
}
$voice.Voice = $matching[0]
$rate = if ($env:CHATGPT_BUTTON_TTS_RATE) { [int]$env:CHATGPT_BUTTON_TTS_RATE } else { 2 }
if ($rate -lt -10 -or $rate -gt 10) { throw 'CHATGPT_BUTTON_TTS_RATE must be between -10 and 10.' }
$voice.Rate = $rate
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
[void]$voice.Speak($text, 0)
