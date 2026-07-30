import Image from "next/image";

export function SupportedBy() {
  return (
    <div className="supported-by">
      <p className="supported-by__label">Supported by</p>
      <a
        href="https://elevenlabs.io/"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="ElevenLabs Grants — abrir site da ElevenLabs em nova aba"
        className="supported-by__link"
      >
        <Image
          src="/Grants-logo.png"
          alt="ElevenLabs Grants"
          width={848}
          height={80}
          priority
          className="supported-by__logo"
        />
      </a>
    </div>
  );
}
