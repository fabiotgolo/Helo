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
          src="/elevenlabs-logo-black.svg"
          alt="ElevenLabs"
          width={946}
          height={90}
          priority
          className="supported-by__logo supported-by__logo--light"
        />
        <Image
          src="/elevenlabs-logo-white.svg"
          alt="ElevenLabs"
          width={946}
          height={90}
          priority
          className="supported-by__logo supported-by__logo--dark"
        />
      </a>
    </div>
  );
}
