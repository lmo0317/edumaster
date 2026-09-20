using System.Text.Json;
using EduMaster.Core;
namespace EduMaster.Web;
public sealed record ImageSource(VisualPage[] Pages,DateTime Created);
public sealed class ImageSourceCache(string directory)
{
    static bool ValidId(string id)=>Guid.TryParseExact(id,"N",out _);
    string CachePath(string id)=>ValidId(id)?Path.Combine(directory,id+".json"):throw new ArgumentException("잘못된 원본 식별값입니다.");
    public Dictionary<string,ImageSource> Load(DateTime now)
    {
        Directory.CreateDirectory(directory);var sources=new Dictionary<string,ImageSource>();
        foreach(var path in Directory.EnumerateFiles(directory,"*.json")){
            var id=Path.GetFileNameWithoutExtension(path);if(!ValidId(id))continue;
            try{
                if(new FileInfo(path).Length>15*1024*1024)throw new InvalidDataException();
                var source=JsonSerializer.Deserialize<ImageSource>(File.ReadAllBytes(path));
                if(source is null || source.Created>now.AddMinutes(1) || now-source.Created>=TimeSpan.FromHours(2) || source.Pages is not{Length:>0 and <=5} || source.Pages.Any(p=>p is null||p.Bytes is not{Length:>0}||p.MimeType is not("image/png" or "image/jpeg")||p.Page is <1 or >5) || source.Pages.Sum(p=>(long)p.Bytes.Length)>FileImport.MaxBytes || sources.Count>=10)throw new InvalidDataException();
                sources.Add(id,source);
            }catch(Exception e)when(e is JsonException or InvalidDataException or ArgumentException){File.Delete(path);}
        }
        return sources;
    }
    public async Task SaveAsync(string id,ImageSource source,CancellationToken token=default)
    {
        Directory.CreateDirectory(directory);var path=CachePath(id);var temporary=path+".tmp";
        try{await File.WriteAllBytesAsync(temporary,JsonSerializer.SerializeToUtf8Bytes(source,new JsonSerializerOptions{IgnoreReadOnlyProperties=true}),token);File.Move(temporary,path,true);}
        finally{if(File.Exists(temporary))File.Delete(temporary);}
    }
    public void Remove(string id)=>File.Delete(CachePath(id));
}

