namespace Acme.Core;

public interface IRepository
{
    Customer Find(int id);
}
