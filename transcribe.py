import sys
import whisper
import json

def transcrever(caminho_audio):
    model = whisper.load_model("base")
    result = model.transcribe(caminho_audio, language="pt")
    print(json.dumps({"text": result["text"]}))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Caminho do arquivo não informado"}))
        sys.exit(1)
    transcrever(sys.argv[1])
