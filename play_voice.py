import sys
from gtts import gTTS
import os
from playsound import playsound

# Archivo de audio temporal
AUDIO_FILE = "speech.mp3"

def process_message(message):
    """
    Procesa un mensaje para convertirlo en audio y reproducirlo.
    """
    try:
        # Generar el audio con gTTS
        tts = gTTS(text=message, lang='es', slow=False)
        tts.save(AUDIO_FILE)

        # Reproducir el audio generado
        playsound(AUDIO_FILE)

        # Eliminar el archivo después de reproducir
        os.remove(AUDIO_FILE)
    except Exception as e:
        print(f"Error al procesar el mensaje: {e}")

if __name__ == "__main__":
    print("Esperando mensajes...")
    for line in sys.stdin:
        line = line.strip()  # Elimina espacios en blanco y saltos de línea
        if line:
            print(f"Procesando: {line}")
            process_message(line)
