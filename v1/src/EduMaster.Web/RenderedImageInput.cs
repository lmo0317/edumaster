using System.Buffers.Binary;
namespace EduMaster.Web;
public static class RenderedImageInput
{
    public static byte[] Decode(string? data)
    {
        const string prefix="data:image/png;base64,";
        if(data is null||!data.StartsWith(prefix,StringComparison.Ordinal)||data.Length>14*1024*1024)throw new ArgumentException("검사할 PNG 형식·크기를 확인해 주세요.");
        byte[] png;try{png=Convert.FromBase64String(data[prefix.Length..]);}catch(FormatException){throw new ArgumentException("PNG를 읽지 못했습니다.");}
        if(png.Length is <33 or >10*1024*1024||!png.AsSpan(0,8).SequenceEqual(new byte[]{137,80,78,71,13,10,26,10})||!png.AsSpan(12,4).SequenceEqual("IHDR"u8))throw new ArgumentException("PNG 헤더가 올바르지 않습니다.");
        var w=BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(16,4));var h=BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(20,4));
        if(w is <1 or >20000||h is <1 or >20000||(long)w*h>20_000_000)throw new ArgumentException("검사할 이미지 해상도가 너무 큽니다.");return png;
    }
}
